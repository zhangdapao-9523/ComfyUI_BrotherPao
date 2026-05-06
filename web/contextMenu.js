import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SETTING_ID = "ComfyUI_BrotherPao.MenuNestSub";
var enableMenuNestSub = false;

var MODEL_EXTENSIONS = [
    '.ckpt', '.safetensors', '.bin', '.pt', '.pth',
    '.gguf', '.onnx', '.pb', '.engine', '.diff',
    '.tensor', '.model', '.param', '.weights'
];

async function loadConfig() {
    try {
        var response = await api.fetchApi("/brotherpao/config");
        if (response.status === 200) {
            var config = await response.json();
            enableMenuNestSub = config.menu_nest_sub || false;
        }
    } catch (e) {
        console.error("[BrotherPao] loadConfig failed:", e);
    }
}

async function saveConfig(key, value) {
    try {
        await api.fetchApi("/brotherpao/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify((function () { var o = {}; o[key] = value; return o; })())
        });
    } catch (e) {
        console.error("[BrotherPao] saveConfig failed:", e);
    }
}

function addMenuNestSubSetting() {
    app.ui.settings.addSetting({
        id: SETTING_ID,
        name: "启用上下文菜单自动嵌套子目录",
        type: "boolean",
        defaultValue: enableMenuNestSub,
        async onChange(value) {
            enableMenuNestSub = !!value;
            await saveConfig("menu_nest_sub", enableMenuNestSub);
        }
    });
}

function getEnableMenuNestSub() {
    return app.ui.settings.getSettingValue(SETTING_ID, enableMenuNestSub);
}

function isModelMenu(values) {
    var lowerVal = values.join('').toLowerCase();
    for (var i = 0; i < MODEL_EXTENSIONS.length; i++) {
        if (lowerVal.indexOf(MODEL_EXTENSIONS[i]) !== -1) {
            return true;
        }
    }
    return false;
}

function patchContextMenu() {
    if (typeof LiteGraph === 'undefined' || !LiteGraph.ContextMenu) {
        setTimeout(function () { patchContextMenu(); }, 100);
        return;
    }

    var existingContextMenu = LiteGraph.ContextMenu;

    LiteGraph.ContextMenu = function (values, options) {
        var hasCallback = options && options.callback;
        var allStrings = !values.some(function (v) { return typeof v !== 'string'; });

        if (!hasCallback || !allStrings || !getEnableMenuNestSub() || !isModelMenu(values)) {
            return existingContextMenu.apply(this, arguments);
        }

        var originalValues = [].concat(values);
        var oldcallback = options.callback;

        var newCallback = function (item, opt) {
            if (['None', '\u65e0', '\u7121', '\u306a\u3057'].indexOf(item.content) !== -1) {
                oldcallback('None', opt);
            } else {
                oldcallback(originalValues.find(function (v) { return v.endsWith(item.content); }), opt);
            }
        };

        var addContent = function (content) {
            return { content: content, callback: newCallback };
        };

        var folders = {};
        var specialOps = [];
        var folderless = [];

        for (var i = 0; i < originalValues.length; i++) {
            var val = originalValues[i];
            var splitBy = val.indexOf('/') > -1 ? '/' : '\\';
            var parts = val.split(splitBy);
            if (parts.length > 1) {
                var key = parts.shift();
                if (!folders[key]) folders[key] = [];
                folders[key].push({ value: parts.join(splitBy), fullValue: val });
            } else if (val === 'CHOOSE' || val.indexOf('DISABLE ') === 0) {
                specialOps.push({ value: val, fullValue: val });
            } else {
                folderless.push({ value: val, fullValue: val });
            }
        }

        var folderEntries = [];
        for (var folderName in folders) {
            if (folders.hasOwnProperty(folderName)) {
                folderEntries.push([folderName, folders[folderName]]);
            }
        }

        if (folderEntries.length === 0) {
            return existingContextMenu.apply(this, arguments);
        }

        options.callback = null;

        var buildSubFolder = function (items) {
            var subs = [];
            var leafs = [];

            items.forEach(function (item) {
                var splitBy = item.value.indexOf('/') > -1 ? '/' : '\\';
                var parts = item.value.split(splitBy);
                if (parts.length > 1) {
                    var k = parts.shift();
                    subs.push({ key: k, value: { value: parts.join(splitBy), fullValue: item.fullValue } });
                } else if (folderEntries.length > 0) {
                    leafs.push(addContent(item.value));
                }
            });

            if (subs.length > 0) {
                var grouped = {};
                subs.forEach(function (sub) {
                    if (!grouped[sub.key]) grouped[sub.key] = [];
                    grouped[sub.key].push(sub.value);
                });
                var subFolders = [];
                for (var key in grouped) {
                    if (grouped.hasOwnProperty(key)) {
                        subFolders.push({
                            content: key,
                            has_submenu: true,
                            callback: function () { },
                            submenu: { options: buildSubFolder(grouped[key]) }
                        });
                    }
                }
                return subFolders.concat(leafs);
            }
            return items.map(function (item) { return addContent(item.value); });
        };

        var newValues = [];
        folderEntries.forEach(function (entry) {
            newValues.push({
                content: entry[0],
                has_submenu: true,
                callback: function () { },
                submenu: { options: buildSubFolder(entry[1]) }
            });
        });
        folderless.forEach(function (item) { newValues.push(addContent(item.value)); });
        specialOps.forEach(function (item) { newValues.push(addContent(item.value)); });

        return existingContextMenu.call(this, newValues, options);
    };
    LiteGraph.ContextMenu.prototype = existingContextMenu.prototype;
}

app.registerExtension({
    name: "comfy.brotherpao.contextMenu",
    async setup() {
        await loadConfig();
        addMenuNestSubSetting();
        patchContextMenu();
    },
});
