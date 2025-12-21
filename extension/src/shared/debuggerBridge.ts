export async function attachToTab(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      chrome.debugger.sendCommand({ tabId }, "Page.enable");
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
      chrome.debugger.sendCommand({ tabId }, "Page.setBypassCSP", { enabled: true });
      resolve();
    });
  });
}

export async function evalInTab(
  tabId: number,
  expression: string
): Promise<{ value?: any; exceptionDetails?: any }> {
  type EvalResult = { result?: { value?: any }; exceptionDetails?: any };
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      (result: EvalResult | undefined) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve({
          value: result?.result?.value,
          exceptionDetails: result?.exceptionDetails
        });
      }
    );
  });
}

export async function detachFromTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}
