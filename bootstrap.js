/* SPDX-License-Identifier: AGPL-3.0-or-later */
var CloudOnDemand;
var CloudChromeHandle;
async function startup(data) {
  await Zotero.initializationPromise;
  // Zotero already provides web globals in this privileged plugin sandbox.
  // Loading into a plain object loses that global environment, and console
  // and hiddenDOMWindow.TextEncoder are not guaranteed bootstrap globals.
  var stage = "loading core.js";
  try {
    stage = "registering settings window resources";
    var addonStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    CloudChromeHandle = addonStartup.registerChrome(
      Services.io.newURI(data.rootURI + "manifest.json"),
      [["content", "cloud-on-demand", data.rootURI]]
    );
    stage = "loading core.js";
    Services.scriptloader.loadSubScript(data.rootURI + "core.js", globalThis, "UTF-8");
    stage = "loading providers.js";
    Services.scriptloader.loadSubScript(data.rootURI + "providers.js", globalThis, "UTF-8");
    stage = "loading runtime.js";
    Services.scriptloader.loadSubScript(data.rootURI + "runtime.js", globalThis, "UTF-8");
    stage = "initializing runtime and menu";
    CloudOnDemand = new CloudRuntime(data, CloudCore, CloudProviders);
    await CloudOnDemand.startup();
    Zotero.debug("Cloud On Demand: startup complete (" + data.version + ")");
  } catch (error) {
    Zotero.logError("Cloud On Demand startup failed while " + stage);
    Zotero.logError(error);
    if (CloudOnDemand) {
      try { await CloudOnDemand.shutdown(); } catch (_) {}
    }
    CloudOnDemand = undefined;
    if (CloudChromeHandle) { CloudChromeHandle.destruct(); CloudChromeHandle = undefined; }
    throw error;
  }
}
function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) { CloudOnDemand?.addWindow(window); }
function onMainWindowUnload({ window }) { CloudOnDemand?.removeWindow(window); }
async function shutdown() {
  try { if (CloudOnDemand) await CloudOnDemand.shutdown(); }
  finally {
    CloudOnDemand = undefined;
    if (CloudChromeHandle) { CloudChromeHandle.destruct(); CloudChromeHandle = undefined; }
  }
}
