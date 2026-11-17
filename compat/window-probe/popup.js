chrome.windows.getCurrent().then((win) => chrome.storage.local.set({ popupWindow: win && win.id }), () => {})
