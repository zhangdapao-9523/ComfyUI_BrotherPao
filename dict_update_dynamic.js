import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI_BaiduTranslate.DynamicDictMerge",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        const typeName = nodeData?.name || nodeType?.type || nodeType?.title || nodeType?.name;
        if (typeName !== "DictionaryUpdate") return;

        const baseInput = "字典";
        const addType = "DICT";
        const minInputs = 2;
        const maxInputs = 10;

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

        function scheduleCompact(node) {
            setTimeout(() => compactNodeHeight(node), 0);
            setTimeout(() => compactNodeHeight(node), 120);
            setTimeout(() => compactNodeHeight(node), 600);
        }

        function listDynamicInputs(node) {
            return node.inputs?.filter(inp => inp?.name?.startsWith(baseInput)) || [];
        }

        function listDynamicInputIndices(node) {
            const idxs = [];
            for (let i = 0; i < (node.inputs?.length || 0); i++) {
                if (node.inputs[i]?.name?.startsWith(baseInput)) idxs.push(i);
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
                const suffix = parseInt(String(inp?.name).slice(baseInput.length), 10);
                if (!isNaN(suffix)) maxIndex = Math.max(maxIndex, suffix);
            }
            return baseInput + (maxIndex + 1);
        }

        function addNextInput(node) {
            const count = listDynamicInputs(node).length;
            if (count >= maxInputs) return;
            const name = nextInputName(node);
            node.addInput(name, addType);
        }

        function renumberDynamicInputs(node) {
            const dynIdxs = listDynamicInputIndices(node);
            for (let i = 0; i < dynIdxs.length; i++) {
                const idx = dynIdxs[i];
                const expected = baseInput + (i + 1);
                const slot = node.inputs?.[idx];
                if (slot && slot.name !== expected) {
                    slot.name = expected;
                }
            }
        }

        function ensureMinInputs(node) {
            const inputs = listDynamicInputs(node);
            const target = Math.min(minInputs, maxInputs);
            while (inputs.length < target) {
                addNextInput(node);
            }
        }

        function ensureSingleTrailingEmpty(node) {
            const dynIdxs = listDynamicInputIndices(node);
            if (dynIdxs.length < minInputs) {
                for (let i = dynIdxs.length; i < minInputs; i++) {
                    addNextInput(node);
                }
            }

            let trailingEmpty = 0;
            for (let i = dynIdxs.length - 1; i >= 0; i--) {
                const idx = dynIdxs[i];
                if (!isConnectedIndex(node, idx)) trailingEmpty += 1;
                else break;
            }

            while (trailingEmpty > 1) {
                const dynIdxs2 = listDynamicInputIndices(node);
                if (dynIdxs2.length <= minInputs) break;
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
            if (isConnectedIndex(node, lastIdx)) {
                const count = listDynamicInputs(node).length;
                if (count < maxInputs) addNextInput(node);
            }
        }

        nodeType.prototype.onConnectionsChange = function(type, slot, connected, link_info, output) {
            const rv = originalOnConnectionsChange?.call(this, type, slot, connected, link_info, output);
            try {
                if (type !== LiteGraph.INPUT) return rv;

                ensureMinInputs(this);
                const dynIdxs = listDynamicInputIndices(this);
                const isLastDynamic = dynIdxs.length > 0 && dynIdxs[dynIdxs.length - 1] === slot;
                const slotName = this.inputs?.[slot]?.name;
                const isDynamicSlot = typeof slotName === "string" && slotName.startsWith(baseInput);

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
                this.setDirtyCanvas(true, true);
                scheduleCompact(this);
            } catch (err) {
                console.error("[BaiduTranslate.DynamicDictMerge] onConnectionsChange error", err);
            }
            return rv;
        };

        const originalOnAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function() {
            originalOnAdded?.call(this);
            try {
                ensureMinInputs(this);
                ensureSingleTrailingEmpty(this);
                renumberDynamicInputs(this);
                this.setDirtyCanvas(true, true);
                scheduleCompact(this);
            } catch (err) {
                console.error("[BaiduTranslate.DynamicDictMerge] onAdded error", err);
            }
        };
    }
});
