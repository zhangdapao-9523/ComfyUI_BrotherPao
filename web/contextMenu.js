import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SETTING_ID = "ComfyUI_BrotherPao.MenuNestSub";
let enableMenuNestSub = false;

const MODEL_EXTENSIONS = [
    '.ckpt', '.safetensors', '.bin', '.pt', '.pth',
    '.gguf', '.onnx', '.pb', '.engine', '.diff',
    '.tensor', '.model', '.param', '.weights'
];

const MAX_PATCH_RETRIES = 50;

async function loadConfig() {
    try {
        const response = await api.fetchApi("/brotherpao/config");
        if (response.status === 200) {
            const config = await response.json();
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
            body: JSON.stringify({ [key]: value })
        });
    } catch (e) {
        console.error("[BrotherPao] saveConfig failed:", e);
    }
}

function addMenuNestSubSetting() {
    try {
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
    } catch (e) {
        console.error("[BrotherPao] addMenuNestSubSetting failed:", e);
    }
}

function getEnableMenuNestSub() {
    try {
        return app.ui.settings.getSettingValue(SETTING_ID, enableMenuNestSub);
    } catch (e) {
        console.error("[BrotherPao] getSettingValue failed:", e);
        return enableMenuNestSub;
    }
}

function isModelMenu(values) {
    const lowerVal = values.join('').toLowerCase();
    for (let i = 0; i < MODEL_EXTENSIONS.length; i++) {
        if (lowerVal.indexOf(MODEL_EXTENSIONS[i]) !== -1) {
            return true;
        }
    }
    return false;
}

function patchContextMenu(retryCount = 0) {
    if (typeof LiteGraph === 'undefined' || !LiteGraph.ContextMenu) {
        if (retryCount < MAX_PATCH_RETRIES) {
            setTimeout(function () { patchContextMenu(retryCount + 1); }, 100);
        } else {
            console.error("[BrotherPao] patchContextMenu: exceeded max retries, LiteGraph.ContextMenu not found");
        }
        return;
    }

    const existingContextMenu = LiteGraph.ContextMenu;

    try {
        LiteGraph.ContextMenu = function (values, options) {
            const hasCallback = options && options.callback;
            const allStrings = !values.some(function (v) { return typeof v !== 'string'; });

            if (!hasCallback || !allStrings || !getEnableMenuNestSub() || !isModelMenu(values)) {
                return existingContextMenu.apply(this, arguments);
            }

            const originalValues = [].concat(values);
            const oldcallback = options.callback;

            const newCallback = function (item, opt) {
                if (['None', '\u65e0', '\u7121', '\u306a\u3057'].indexOf(item.content) !== -1) {
                    oldcallback('None', opt);
                } else {
                    oldcallback(originalValues.find(function (v) { return v.endsWith(item.content); }), opt);
                }
            };

            const addContent = function (content) {
                return { content: content, callback: newCallback };
            };

            const folders = {};
            const specialOps = [];
            const folderless = [];

            for (let i = 0; i < originalValues.length; i++) {
                const val = originalValues[i];
                const splitBy = val.indexOf('/') > -1 ? '/' : '\\';
                const parts = val.split(splitBy);
                if (parts.length > 1) {
                    const key = parts.shift();
                    if (!folders[key]) folders[key] = [];
                    folders[key].push({ value: parts.join(splitBy), fullValue: val });
                } else if (val === 'CHOOSE' || val.indexOf('DISABLE ') === 0) {
                    specialOps.push({ value: val, fullValue: val });
                } else {
                    folderless.push({ value: val, fullValue: val });
                }
            }

            const folderEntries = [];
            for (const folderName in folders) {
                if (folders.hasOwnProperty(folderName)) {
                    folderEntries.push([folderName, folders[folderName]]);
                }
            }

            if (folderEntries.length === 0) {
                return existingContextMenu.apply(this, arguments);
            }

            options.callback = null;

            const buildSubFolder = function (items) {
                const subs = [];
                const leafs = [];

                items.forEach(function (item) {
                    const splitBy = item.value.indexOf('/') > -1 ? '/' : '\\';
                    const parts = item.value.split(splitBy);
                    if (parts.length > 1) {
                        const k = parts.shift();
                        subs.push({ key: k, value: { value: parts.join(splitBy), fullValue: item.fullValue } });
                    } else if (folderEntries.length > 0) {
                        leafs.push(addContent(item.value));
                    }
                });

                if (subs.length > 0) {
                    const grouped = {};
                    subs.forEach(function (sub) {
                        if (!grouped[sub.key]) grouped[sub.key] = [];
                        grouped[sub.key].push(sub.value);
                    });
                    const subFolders = [];
                    for (const key in grouped) {
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

            const newValues = [];
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
    } catch (e) {
        console.error("[BrotherPao] Failed to patch LiteGraph.ContextMenu:", e);
    }
}

app.registerExtension({
    name: "comfy.brotherpao.contextMenu",
    async setup() {
        try {
            await loadConfig();
            addMenuNestSubSetting();
            patchContextMenu();
        } catch (e) {
            console.error("[BrotherPao] contextMenu setup failed:", e);
        }
    },
});
