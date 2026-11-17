// The way the main process of Lucium reaches the keychain service of the password vault (native/vault-keychain/, an XPC service of the
// application): a Node-API addon, loaded by src/main/vault-keychain.ts from Contents/Resources/vault-xpc.node (outside app.asar).
//
// Why XPC and not a program on pipes: a message of XPC carries the audit token of its sender as the kernel stamped it when it was sent, and the
// service has the system check Lucium's signature on every one. A pipe tells nothing of who writes or reads it now.
//
// What it exposes:
//   sendRequest(json, timeoutMs) -> Promise<string>  one request, answered with the JSON of the answer, or rejected with an Error whose `code` is
//                                                     a short kind: untrusted (this application has no team, or the service is not signed as
//                                                     Lucium's), no-reply, interrupted, invalid, timeout, cancelled
//   cancelAll()                                       every pending request rejected with "cancelled" and its connections closed (at quit): the
//                                                     service then takes its prompt off the screen
//   trusted()                                         whether this application has a team to require of the service
//
// Rules this file keeps (src/main/vault-keychain-native.test.ts reads them in this source):
//  - the service is required to be `identifier "app.lucium.browser.keychain" and anchor apple generic and certificate leaf[subject.OU] =
//    "<team>"`, the team read on this very process (SecCodeCopySelf); without a team nothing is sent at all;
//  - the requirement is set on both connections before they are activated; the system checks it on every reply;
//  - the request is sent only on the connection made from the endpoint the service answered on the named one, after that answer passed the
//    requirement: a connection looked up by name could be sent elsewhere by a later lookup, one made from an endpoint never is;
//  - the copies of the request and of the answer held here are wiped once handed over (the strings of JavaScript and the copies inside XPC's
//    messages cannot be);
//  - nothing is logged.
//
// Threads: every event of XPC, every timer and every change to a request run on one serial queue; JavaScript is reached back through a
// thread-safe function per request.

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <xpc/xpc.h>

#define SERVICE_NAME "app.lucium.browser.keychain"
/** A request is a few hundred bytes (the service refuses more than 16 KiB), an answer one short line of JSON. */
#define REQUEST_LIMIT (16 * 1024)
#define ANSWER_LIMIT 4096
#define TIMEOUT_LIMIT_MS (10 * 60 * 1000)
#define TEAM_LENGTH 10

typedef struct request {
  napi_deferred deferred;
  napi_threadsafe_function done;
  xpc_connection_t named;
  xpc_connection_t direct;
  dispatch_source_t timer;
  /** The JSON of the request (wiped once XPC has its copy), and the answer (wiped once JavaScript has its copy). */
  char *text;
  size_t text_length;
  char *answer;
  size_t answer_length;
  /** The time limit of the whole request. */
  int64_t timeout_ms;
  /** The kind of the failure, or NULL. */
  const char *failure;
  int settled;
  /** What still holds this request: the pending state, each reply awaited, the timer. Changed on the queue only. */
  int holds;
  struct request *next;
} request_t;

static dispatch_queue_t queue;
/** The requirement of the service, or an empty string when this application has no team. Written once. */
static char service_requirement[256];
static dispatch_once_t requirement_once;
/** The requests not settled yet, on the queue only. */
static request_t *pending;

static void wipe(void *bytes, size_t length) {
  if (bytes && length > 0) memset_s(bytes, length, 0, length);
}

/** Whether `team` is a team identifier as Apple gives them: ten capitals and digits. */
static int is_team(const char *team) {
  if (strlen(team) != TEAM_LENGTH) return 0;
  for (const char *c = team; *c; c++) {
    if (!((*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9'))) return 0;
  }
  return 1;
}

/** The team of this process's own signature, read by the system: none signed ad hoc or unsigned. */
static void read_requirement(void *unused) {
  (void)unused;
  service_requirement[0] = '\0';
  SecCodeRef running = NULL;
  SecStaticCodeRef on_disk = NULL;
  CFDictionaryRef information = NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &running) != errSecSuccess) goto done;
  if (SecCodeCopyStaticCode(running, kSecCSDefaultFlags, &on_disk) != errSecSuccess) goto done;
  if (SecCodeCopySigningInformation(on_disk, kSecCSSigningInformation, &information) != errSecSuccess) goto done;
  CFTypeRef value = CFDictionaryGetValue(information, kSecCodeInfoTeamIdentifier);
  char team[TEAM_LENGTH + 2] = {0};
  if (!value || CFGetTypeID(value) != CFStringGetTypeID() || !CFStringGetCString((CFStringRef)value, team, sizeof team, kCFStringEncodingUTF8)) goto done;
  if (!is_team(team)) goto done;
  snprintf(service_requirement, sizeof service_requirement, "identifier \"%s\" and anchor apple generic and certificate leaf[subject.OU] = \"%s\"", SERVICE_NAME, team);
done:
  if (information) CFRelease(information);
  if (on_disk) CFRelease(on_disk);
  if (running) CFRelease(running);
}

static const char *requirement(void) {
  dispatch_once_f(&requirement_once, NULL, read_requirement);
  return service_requirement[0] ? service_requirement : NULL;
}

static void release_request(request_t *r) {
  if (--r->holds > 0) return;
  wipe(r->text, r->text_length);
  free(r->text);
  wipe(r->answer, r->answer_length);
  free(r->answer);
  free(r);
}

static void release_on_queue(void *context) { release_request((request_t *)context); }

static void close_connection(xpc_connection_t *connection) {
  if (!*connection) return;
  xpc_connection_cancel(*connection);
  xpc_release(*connection);
  *connection = NULL;
}

/** Ends a request once: its connections closed, its timer stopped, its promise settled in JavaScript. On the queue. */
static void settle(request_t *r, const char *failure) {
  if (r->settled) return;
  r->settled = 1;
  r->failure = failure;
  for (request_t **at = &pending; *at; at = &(*at)->next) {
    if (*at == r) {
      *at = r->next;
      break;
    }
  }
  if (r->timer) {
    // Its cancel handler still runs, and gives back the timer's hold.
    dispatch_source_cancel(r->timer);
    dispatch_release(r->timer);
    r->timer = NULL;
  }
  close_connection(&r->direct);
  close_connection(&r->named);
  wipe(r->text, r->text_length);
  // The hold of the pending state goes to JavaScript, which gives it back once the promise is settled.
  if (napi_call_threadsafe_function(r->done, r, napi_tsfn_nonblocking) != napi_ok) release_request(r);
  napi_release_threadsafe_function(r->done, napi_tsfn_release);
}

/** The kind of an error of XPC. */
static const char *kind_of(xpc_object_t error) {
  if (error == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT) return "untrusted";
  if (error == XPC_ERROR_CONNECTION_INTERRUPTED) return "interrupted";
  return "no-reply";
}

static xpc_connection_t ready(xpc_connection_t connection) {
  // Every failure of a request comes to the handler of its reply: the events of the connection itself are not needed.
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    (void)event;
  });
  xpc_connection_activate(connection);
  return connection;
}

/** The answer of step 2: the JSON of the service's answer. */
static void answered(request_t *r, xpc_object_t reply) {
  if (r->settled) return;
  if (xpc_get_type(reply) != XPC_TYPE_DICTIONARY) {
    settle(r, kind_of(reply));
    return;
  }
  xpc_object_t value = xpc_dictionary_get_value(reply, "answer");
  if (!value || xpc_get_type(value) != XPC_TYPE_STRING || xpc_string_get_length(value) > ANSWER_LIMIT) {
    settle(r, "invalid");
    return;
  }
  size_t length = xpc_string_get_length(value);
  r->answer = malloc(length + 1);
  if (!r->answer) {
    settle(r, "invalid");
    return;
  }
  memcpy(r->answer, xpc_string_get_string_ptr(value), length);
  r->answer[length] = '\0';
  r->answer_length = length;
  settle(r, NULL);
}

/**
 * The answer of step 1, which the system checked against the requirement: the endpoint of a listener of the service made for this request. The
 * request goes there, and only there.
 */
static void opened(request_t *r, xpc_object_t reply) {
  if (r->settled) return;
  if (xpc_get_type(reply) != XPC_TYPE_DICTIONARY) {
    settle(r, kind_of(reply));
    return;
  }
  xpc_object_t endpoint = xpc_dictionary_get_value(reply, "endpoint");
  if (!endpoint || xpc_get_type(endpoint) != XPC_TYPE_ENDPOINT) {
    settle(r, "invalid");
    return;
  }
  r->direct = xpc_connection_create_from_endpoint((xpc_endpoint_t)endpoint);
  xpc_connection_set_target_queue(r->direct, queue);
  // THE GUARD of the second connection, before it is activated: the same requirement, on every reply.
  if (xpc_connection_set_peer_code_signing_requirement(r->direct, requirement()) != 0) {
    ready(r->direct);
    settle(r, "untrusted");
    return;
  }
  ready(r->direct);
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "request", r->text);
  wipe(r->text, r->text_length);
  r->holds++;
  xpc_connection_send_message_with_reply(r->direct, message, queue, ^(xpc_object_t answer) {
    answered(r, answer);
    release_request(r);
  });
  xpc_release(message);
  // The named connection has done its part.
  close_connection(&r->named);
}

static void timed_out(void *context) { settle((request_t *)context, "timeout"); }

/** Starts a request on the queue: a timer, then step 1 on the connection made by the service's name. */
static void start(void *context) {
  request_t *r = context;
  r->next = pending;
  pending = r;
  r->timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  dispatch_set_context(r->timer, r);
  dispatch_source_set_event_handler_f(r->timer, timed_out);
  r->holds++;
  dispatch_source_set_cancel_handler_f(r->timer, release_on_queue);
  dispatch_source_set_timer(r->timer, dispatch_time(DISPATCH_TIME_NOW, r->timeout_ms * (int64_t)NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 10 * NSEC_PER_MSEC);
  dispatch_resume(r->timer);
  r->named = xpc_connection_create(SERVICE_NAME, queue);
  // THE GUARD of the first connection, before it is activated: only the keychain service of this application's own team is believed.
  if (xpc_connection_set_peer_code_signing_requirement(r->named, requirement()) != 0) {
    // Activated only to be closed (an inactive connection cannot be let go): nothing is ever sent on it.
    ready(r->named);
    settle(r, "untrusted");
    return;
  }
  ready(r->named);
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  r->holds++;
  xpc_connection_send_message_with_reply(r->named, message, queue, ^(xpc_object_t reply) {
    opened(r, reply);
    release_request(r);
  });
  xpc_release(message);
}

static void cancel_pending(void *unused) {
  (void)unused;
  while (pending) settle(pending, "cancelled");
}

static napi_value reject_with(napi_env env, napi_deferred deferred, const char *kind) {
  napi_value code, message, error;
  char text[64];
  snprintf(text, sizeof text, "vault-xpc: %s", kind);
  napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, code, message, &error);
  napi_reject_deferred(env, deferred, error);
  return NULL;
}

/** Settles the promise of a request, in JavaScript. With no `env` (the environment is going away), only the request is let go. */
static void call_js(napi_env env, napi_value callback, void *context, void *data) {
  (void)callback;
  (void)context;
  request_t *r = data;
  if (env) {
    if (r->failure) {
      reject_with(env, r->deferred, r->failure);
    } else {
      napi_value answer;
      if (napi_create_string_utf8(env, r->answer, r->answer_length, &answer) == napi_ok) napi_resolve_deferred(env, r->deferred, answer);
      else reject_with(env, r->deferred, "invalid");
    }
  }
  dispatch_async_f(queue, r, release_on_queue);
}

static napi_value send_request(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], promise, name;
  napi_deferred deferred;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return NULL;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return NULL;
  napi_valuetype type;
  size_t length = 0;
  int64_t timeout = 0;
  if (argc < 2 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string || napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 || length > REQUEST_LIMIT) {
    reject_with(env, deferred, "invalid");
    return promise;
  }
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_number || napi_get_value_int64(env, argv[1], &timeout) != napi_ok || timeout < 1 || timeout > TIMEOUT_LIMIT_MS) {
    reject_with(env, deferred, "invalid");
    return promise;
  }
  // THE GUARD: an application without a team has nothing to require of the service, and sends it nothing.
  if (!requirement()) {
    reject_with(env, deferred, "untrusted");
    return promise;
  }
  request_t *r = calloc(1, sizeof *r);
  if (!r || !(r->text = malloc(length + 1))) {
    free(r);
    reject_with(env, deferred, "invalid");
    return promise;
  }
  size_t copied = 0;
  napi_get_value_string_utf8(env, argv[0], r->text, length + 1, &copied);
  r->text_length = copied;
  r->deferred = deferred;
  r->holds = 1;
  r->timeout_ms = timeout;
  napi_create_string_utf8(env, "vault-xpc", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, call_js, &r->done) != napi_ok) {
    wipe(r->text, r->text_length);
    free(r->text);
    free(r);
    reject_with(env, deferred, "invalid");
    return promise;
  }
  dispatch_async_f(queue, r, start);
  return promise;
}

static napi_value cancel_all(napi_env env, napi_callback_info info) {
  (void)env;
  (void)info;
  // Synchronous: once this returns, every connection is closed (nothing on the queue ever waits for JavaScript).
  dispatch_sync_f(queue, NULL, cancel_pending);
  return NULL;
}

static napi_value trusted(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_get_boolean(env, requirement() != NULL, &result);
  return result;
}

static void make_queue(void *unused) {
  (void)unused;
  queue = dispatch_queue_create("app.lucium.browser.vault-xpc", DISPATCH_QUEUE_SERIAL);
}

NAPI_MODULE_INIT() {
  static dispatch_once_t once;
  dispatch_once_f(&once, NULL, make_queue);
  napi_property_descriptor properties[] = {
    {"sendRequest", NULL, send_request, NULL, NULL, NULL, napi_enumerable, NULL},
    {"cancelAll", NULL, cancel_all, NULL, NULL, NULL, napi_enumerable, NULL},
    {"trusted", NULL, trusted, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties);
  return exports;
}
