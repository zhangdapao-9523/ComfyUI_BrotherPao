import { app } from "../../scripts/app.js";

function fitContain(srcW, srcH, maxW, maxH) {
    if (!srcW || !srcH || !maxW || !maxH) {
        return { x: 0, y: 0, w: 0, h: 0 };
    }
    var s = Math.min(maxW / srcW, maxH / srcH);
    var w = Math.max(1, Math.floor(srcW * s));
    var h = Math.max(1, Math.floor(srcH * s));
    return {
        x: Math.floor((maxW - w) / 2),
        y: Math.floor((maxH - h) / 2),
        w: w,
        h: h
    };
}

function getDrawGeom(node) {
    var margin = 10;
    var topOffset = 40;
    return {
        drawX: margin,
        drawY: margin + topOffset,
        drawW: node.size[0] - margin * 2,
        drawH: node.size[1] - margin * 2 - topOffset
    };
}

function drawCompareFrame(node, ctx) {
    var geom = getDrawGeom(node);
    var dx = geom.drawX, dy = geom.drawY, dw = geom.drawW, dh = geom.drawH;

    ctx.fillStyle = "#111";
    ctx.fillRect(dx, dy, dw, dh);

    var rectA = fitContain(
        (node.imgA && node.imgA.width) || dw,
        (node.imgA && node.imgA.height) || dh,
        dw, dh
    );
    var rectB = fitContain(
        (node.imgB && node.imgB.width) || dw,
        (node.imgB && node.imgB.height) || dh,
        dw, dh
    );

    if (node.imgB) {
        ctx.drawImage(node.imgB, dx + rectB.x, dy + rectB.y, rectB.w, rectB.h);
    }

    if (node.imgA) {
        var splitX = dx + Math.floor(dw * node.sliderPos);

        ctx.save();
        ctx.beginPath();
        ctx.rect(dx, dy, splitX - dx, dh);
        ctx.clip();
        ctx.drawImage(node.imgA, dx + rectA.x, dy + rectA.y, rectA.w, rectA.h);
        ctx.restore();

        ctx.strokeStyle = "#00e0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(splitX, dy);
        ctx.lineTo(splitX, dy + dh);
        ctx.stroke();

        if (node.hovered || node.dragging) {
            ctx.fillStyle = "#00e0ff";
            ctx.beginPath();
            ctx.arc(splitX, dy + dh / 2, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.fillStyle = "white";
    ctx.font = "bold 14px sans-serif";
    ctx.shadowColor = "black";
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 0;
    ctx.fillText("原图", dx + 8, dy + 20);
    ctx.fillText("对比图", dx + dw - 58, dy + 20);

    if (node.imgA && node.imgB) {
        ctx.font = "normal 10px sans-serif";
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillText(node.imgA.width + "x" + node.imgA.height, dx + 8, dy + 34);
        ctx.textAlign = "right";
        ctx.fillText(node.imgB.width + "x" + node.imgB.height, dx + dw - 10, dy + 34);
        ctx.textAlign = "start";
    }
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.ImageCompareNode",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "ImageCompareNode") return;

        var origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            if (!this.size || this.size[0] < 100 || this.size[1] < 100) {
                this.size = [532, 582];
            }

            this.sliderPos = 0.5;
            this.dragging = false;
            this.hovered = false;

            var self = this;

            this.onMouseDown = function (_, pos) {
                var geom = getDrawGeom(self);
                var x = pos[0] - geom.drawX;
                var y = pos[1] - geom.drawY;
                if (x < 0 || x > geom.drawW || y < 0 || y > geom.drawH) return false;

                var splitX = geom.drawX + Math.floor(geom.drawW * self.sliderPos);
                self.dragging = true;
                if (Math.hypot(pos[0] - splitX, pos[1] - (geom.drawY + geom.drawH / 2)) >= 15) {
                    self.sliderPos = Math.max(0, Math.min(1, x / geom.drawW));
                }
                return true;
            };

            this.onMouseMove = function (e, pos) {
                var geom = getDrawGeom(self);
                var splitX = geom.drawX + Math.floor(geom.drawW * self.sliderPos);
                self.hovered = Math.hypot(pos[0] - splitX, pos[1] - (geom.drawY + geom.drawH / 2)) < 15;

                if (self.dragging) {
                    if (e && e.buttons !== undefined && e.buttons === 0) self.dragging = false;
                    var nx = (pos[0] - geom.drawX) / geom.drawW;
                    nx = Math.max(0, Math.min(1, nx));
                    if (Math.abs(nx - self.sliderPos) > 0.001) self.sliderPos = nx;
                }
            };

            this.onDrawForeground = function (ctx) {
                if (self.flags && self.flags.collapsed) return;
                ctx.save();
                drawCompareFrame(self, ctx);
                ctx.restore();
            };

            var origOnExecuted = this.onExecuted;
            this.onExecuted = function (output) {
                if (origOnExecuted) origOnExecuted.apply(this, arguments);

                if (output && output.b64_a && output.b64_b) {
                    if (self.imgA) self.imgA.onload = self.imgA.onerror = null;
                    if (self.imgB) self.imgB.onload = self.imgB.onerror = null;

                    self.imgA = new Image();
                    self.imgB = new Image();

                    self.imgA.onload = function () {
                        if (app.canvas) app.canvas.setDirty(true);
                    };
                    self.imgB.onload = function () {
                        if (app.canvas) app.canvas.setDirty(true);
                    };

                    var aData = Array.isArray(output.b64_a) ? output.b64_a.join("") : output.b64_a;
                    var bData = Array.isArray(output.b64_b) ? output.b64_b.join("") : output.b64_b;
                    self.imgA.src = "data:image/png;base64," + aData;
                    self.imgB.src = "data:image/png;base64," + bData;
                }
            };
        };
    },
});
