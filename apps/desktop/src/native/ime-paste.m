// Loaded once by Electron's main process. AppKit delivers composition keystrokes to the
// input method before Electron's before-input-event, even when Command is held.
#import <AppKit/AppKit.h>
#include <node_api.h>

static NSEvent *routePaste(NSEvent *event) {
  const NSEventModifierFlags shortcutModifiers = NSEventModifierFlagCommand |
      NSEventModifierFlagOption | NSEventModifierFlagControl | NSEventModifierFlagShift;
  if ((event.modifierFlags & shortcutModifiers) != NSEventModifierFlagCommand ||
      ![event.charactersIgnoringModifiers.lowercaseString isEqualToString:@"v"] ||
      !event.window.isKeyWindow) {
    return event;
  }

  NSResponder *editor = event.window.firstResponder;
  if ([editor respondsToSelector:@selector(hasMarkedText)] &&
      [(id<NSTextInputClient>)editor hasMarkedText] &&
      [NSApp.mainMenu performKeyEquivalent:event]) {
    return nil; // The menu handled the shortcut. Do not also type it into the candidate.
  }
  return event;
}

static void removeMonitor(void *context) {
  [NSEvent removeMonitor:CFBridgingRelease(context)];
}

static napi_value install(napi_env env, napi_value exports) {
  id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
      handler:^NSEvent *(NSEvent *event) { return routePaste(event); }];
  void *context = (__bridge_retained void *)monitor;
  if (napi_add_env_cleanup_hook(env, removeMonitor, context) != napi_ok) {
    removeMonitor(context);
    napi_throw_error(env, NULL, "Could not install the macOS paste handler");
  }
  return exports;
}

NAPI_MODULE(ime_paste, install)
