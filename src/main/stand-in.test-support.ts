// Test support (nothing of the application imports it): a stand-in that says what it was not given. A stand-in that answers every name with
// something that does nothing lets the method under test call a dependency that was renamed, forgotten or misspelt, and the test stays green
// while the method no longer does its work. This one answers only the members it was given: any other name throws, with the name.

/** What a runtime asks any object without meaning a member of it: a promise check, a conversion to text, an inspection. */
const asked = (member: string | symbol): boolean => typeof member === 'symbol' || member === 'then' || member === 'toJSON' || member === 'constructor' || member === 'asymmetricMatch' || member === 'nodeType' || member === '$$typeof'

/**
 * `own`, and nothing else: reading or calling a member that is not in it throws « <name>.<member> is not given to this stand-in ». What the
 * method under test may touch without the test caring about it is given by name too, as `nothing` (below), so that the list of what a method
 * depends on is written in the test.
 */
export function standIn<T extends object>(name: string, own: T): T {
  return new Proxy(own, {
    get(target, member, receiver) {
      if (member in target || asked(member)) return Reflect.get(target, member, receiver) as unknown
      throw new Error(`${name}.${String(member)} is not given to this stand-in`)
    }
  })
}

/** A dependency the test does not look at: any member of it, any call, any loop over it does nothing. To give by name, never as a fallback. */
export const nothing: unknown = new Proxy(function () {}, {
  get: (_target, member) => (member === Symbol.iterator ? function* () {} : asked(member) ? undefined : nothing),
  apply: () => nothing
})
