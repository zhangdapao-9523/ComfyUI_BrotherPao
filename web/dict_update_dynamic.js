import { app } from "../../scripts/app.js";
import { applyZhLabels } from "./shared_utils.js";

const ZH_LABEL_MAP = {
    "dict": "字典",
    "key": "键",
    "value": "值",
    "default_value": "默认值",
    "merged_dict": "合并后的字典",
};

function getZhLabel(name) {
    if (ZH_LABEL_MAP[name]) return ZH_LABEL_MAP[name];
    const dictMatch = name.match(/^dict(\d+)$/);
    if (dictMatch) return "字典" + dictMatch[1];
    const keyMatch = name.match(/^key(\d+)$/);
    if (keyMatch) return "键" + keyMatch[1];
    const valueMatch = name.match(/^value(\d+)$/);
    if (valueMatch) return "值" + valueMatch[1];
    return null;
}

const BASE_INPUT = "dict";
const ADD_TYPE = "DICT";
const MIN_INPUTS = 2;
const MAX_INPUTS = 10;

app.registerExtension({
    name: "ComfyUI_BrotherPao.DynamicDictMerge",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const typeName = nodeData?.name || nodeType?.type || nodeType?.title || nodeType?.name;
        if (typeName !== "BrotherPao_DictionaryUpdate") return;

        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;

        function compactNodeHeight(node) {
            if (!node || node.flags?.collapsed) return;
            let desiredHeight = null;
            try {
                const computed = node.computeSize?.([node.size?.[0], node.size?.[1]]);
                if (Array.isArray(computed) && computed.length >= 2 && Number.isFinite(computed[1])) {
                    desiredHeight = computed[1];
                }
            } catch (_) {}
            if (Number.isFinite(desiredHeight) && node.size?.[1] > desiredHeight + 2) {
                node.setSize([node.size[0], desiredHeight]);
                node.setDirtyCanvas(true, true);
            }
        }

        let compactRafId = null;
        function scheduleCompact(node) {
            if (compactRafId != null) return;
            compactRafId = requestAnimationFrame(() => {
                compactRafId = null;
                compactNodeHeight(node);
                setTimeout(() => {
                    compactNodeHeight(node);
                }, 200);
            });
        }

        function listDynamicInputs(node) {
            return node.inputs?.filter(inp => inp?.name?.startsWith(BASE_INPUT)) || [];
        }

        function listDynamicInputIndices(node) {
            const idxs = [];
            for (let i = 0; i < (node.inputs?.length || 0); i++) {
                if (node.inputs[i]?.name?.startsWith(BASE_INPUT)) idxs.push(i);
            }
            return idxs;
        }

        function isConnectedIndex(node, idx) {
            return (node.inputs?.[idx] ?? {}).link != null;
        }

        function nextInputName(node) {
            const inputs = listDynamicInputs(node);
            let maxIndex = 0;
            for (const inp of inputs) {
                const suffix = parseInt(String(inp?.name).slice(BASE_INPUT.length), 10);
                if (!isNaN(suffix)) maxIndex = Math.max(maxIndex, suffix);
            }
            return BASE_INPUT + (maxIndex + 1);
        }

        function addNextInput(node) {
            const count = listDynamicInputs(node).length;
            if (count >= MAX_INPUTS) return;
            const name = nextInputName(node);
            node.addInput(name, ADD_TYPE);
        }

        function renumberDynamicInputs(node) {
            const dynIdxs = listDynamicInputIndices(node);
            for (let i = 0; i < dynIdxs.length; i++) {
                const idx = dynIdxs[i];
                const expected = BASE_INPUT + (i + 1);
                const slot = node.inputs?.[idx];
                if (slot && slot.name !== expected) {
                    slot.name = expected;
                }
            }
        }

        function ensureMinInputs(node) {
            const inputs = listDynamicInputs(node);
            const target = Math.min(MIN_INPUTS, MAX_INPUTS);
            while (inputs.length < target) {
                addNextInput(node);
            }
        }

        function ensureSingleTrailingEmpty(node) {
            const dynIdxs = listDynamicInputIndices(node);
            if (dynIdxs.length < MIN_INPUTS) {
                for (let i = dynIdxs.length; i < MIN_INPUTS; i++) {
                    addNextInput(node);
                }
            }

            let trailingEmpty = 0;
            for (let i = dynIdxs.length - 1; i >= 0; i--) {
                if (!isConnectedIndex(node, dynIdxs[i])) trailingEmpty += 1;
                else break;
            }

            while (trailingEmpty > 1) {
                const dynIdxs2 = listDynamicInputIndices(node);
                if (dynIdxs2.length <= MIN_INPUTS) break;
                const lastIdx = dynIdxs2[dynIdxs2.length - 1];
                if (!isConnectedIndex(node, lastIdx)) {
                    node.removeInput(lastIdx);
                    trailingEmpty -= 1;
                } else {
                    break;
                }
            }

            const dynIdxs3 = listDynamicInputIndices(node);
            const lastIdx = dynIdxs3[dynIdxs3.length - 1];
            if (lastIdx !== undefined && isConnectedIndex(node, lastIdx)) {
                const count = listDynamicInputs(node).length;
                if (count < MAX_INPUTS) addNextInput(node);
            }
        }

        nodeType.prototype.onConnectionsChange = function (type, slot, connected, link_info, output) {
            const rv = originalOnConnectionsChange?.call(this, type, slot, connected, link_info, output);
            try {
                if (typeof LiteGraph === 'undefined') return rv;
                if (type !== LiteGraph.INPUT) return rv;

                ensureMinInputs(this);
                const dynIdxs = listDynamicInputIndices(this);
                const isLastDynamic = dynIdxs.length > 0 && dynIdxs[dynIdxs.length - 1] === slot;
                const slotName = this.inputs?.[slot]?.name;
                const isDynamicSlot = typeof slotName === "string" && slotName.startsWith(BASE_INPUT);

                if (connected && isDynamicSlot && isLastDynamic) {
                    addNextInput(this);
                }

                if (!connected && isDynamicSlot) {
                    setTimeout(() => {
                        const idxs = listDynamicInputIndices(this);
                        const pos = idxs.indexOf(slot);
                        if (pos < 0) return;
                        const empty = !isConnectedIndex(this, slot);
                        const laterHasConn = idxs.slice(pos + 1).some(j => isConnectedIndex(this, j));
                        if (empty && laterHasConn) {
                            this.removeInput(slot);
                            addNextInput(this);
                            renumberDynamicInputs(this);
                            ensureSingleTrailingEmpty(this);
                            this.setDirtyCanvas(true, true);
                        }
                    }, 20);
                }

                ensureSingleTrailingEmpty(this);
                renumberDynamicInputs(this);

                for (const inp of this.inputs || []) {
                    const zhLabel = getZhLabel(inp.name);
                    if (zhLabel) {
                        inp.label = zhLabel;
                    }
                }

                this.setDirtyCanvas(true, true);
                scheduleCompact(this);
            } catch (err) {
                console.error("[BrotherPao.DynamicDictMerge] onConnectionsChange error", err);
            }
            return rv;
        };

        const originalOnAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            originalOnAdded?.call(this);
            try {
                for (const inp of this.inputs || []) {
                    const zhLabel = getZhLabel(inp.name);
                    if (zhLabel) {
                        inp.label = zhLabel;
                    }
                }

                for (const o of this.outputs || []) {
                    const zhLabel = getZhLabel(o.name);
                    if (zhLabel) {
                        o.label = zhLabel;
                    }
                }

                ensureMinInputs(this);
                ensureSingleTrailingEmpty(this);
                renumberDynamicInputs(this);
                this.setDirtyCanvas(true, true);
                scheduleCompact(this);
            } catch (err) {
                console.error("[BrotherPao.DynamicDictMerge] onAdded error", err);
            }
        };
    }
});

app.registerExtension({
    name: "ComfyUI_BrotherPao.DictLabelTranslation",
    nodeCreated(node) {
        const dictNodeTypes = ["BrotherPao_DictionaryGet", "BrotherPao_DictionaryNew"];
        if (dictNodeTypes.indexOf(node.comfyClass) === -1) {
            return;
        }

        for (const w of node.widgets || []) {
            const zhLabel = getZhLabel(w.name);
            if (zhLabel) {
                w.label = zhLabel;
            }
        }

        applyZhLabels(node, ZH_LABEL_MAP);
    }
});
