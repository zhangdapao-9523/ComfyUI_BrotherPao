/**
 * ComfyUI_BrotherPao.QwenMultiangleCamera
 *
 * 重构自 ComfyUI-qwenmultiangle (https://github.com/jtydhr88/ComfyUI-qwenmultiangle)
 * 不使用 Vue/构建工具，纯原生 JS + Three.js 实现 3D 相机控制
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ─── Three.js Loader ────────────────────────────────────────────────────────

let THREE = null;
let threeReady = null;

function loadThreeJS() {
    if (THREE) return Promise.resolve(THREE);
    if (threeReady) return threeReady;

    threeReady = (async () => {
        const localPaths = [
            "./three.module.js",
            "/extensions/ComfyUI_BrotherPao/three.module.js",
        ];
        for (const path of localPaths) {
            try { THREE = await import(path); return THREE; } catch (_) { /* next */ }
        }

        const cdnUrls = [
            "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
            "https://unpkg.com/three@0.170.0/build/three.module.js",
        ];
        for (const url of cdnUrls) {
            try { THREE = await import(url); return THREE; } catch (_) { /* next */ }
        }

        throw new Error("Failed to load Three.js");
    })();

    return threeReady;
}

loadThreeJS();

// ─── i18n ───────────────────────────────────────────────────────────────────

const ZH_LABELS = {
    horizontal: "水平", vertical: "垂直", zoom: "距离", resetToDefaults: "重置",
    frontView: "正面视角", frontRightQuarterView: "右前方视角", rightSideView: "右侧视角",
    backRightQuarterView: "右后方视角", backView: "背面视角", backLeftQuarterView: "左后方视角",
    leftSideView: "左侧视角", frontLeftQuarterView: "左前方视角",
    lowAngleShot: "仰拍", eyeLevelShot: "平视", elevatedShot: "高角度", highAngleShot: "俯拍",
    wideShot: "远景", mediumShot: "中景", closeUp: "特写",
};

const LOCALE = (() => {
    try {
        const v = app.ui?.settings?.getSettingValue?.("Comfy.Locale");
        if (v && String(v).toLowerCase().startsWith("zh")) return "zh";
    } catch (_) { /* ignore */ }
    return navigator.language?.startsWith("zh") ? "zh" : "en";
})();

function t(key) {
    return LOCALE === "zh" && ZH_LABELS[key] ? ZH_LABELS[key]
        : key.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

// ─── Prompt generation ──────────────────────────────────────────────────────

let _promptRules = null;

async function fetchPromptRules() {
    if (_promptRules) return _promptRules;
    try {
        const resp = await api.fetchApi("/brotherpao/prompt_rules");
        if (resp.status === 200) {
            _promptRules = await resp.json();
        }
    } catch (_) { /* fallback to defaults */ }
    if (!_promptRules) {
        _promptRules = {
            azimuth: [[337.5,"front view"],[22.5,"front view"],[67.5,"front-right quarter view"],[112.5,"right side view"],[157.5,"back-right quarter view"],[202.5,"back view"],[247.5,"back-left quarter view"],[292.5,"left side view"],[337.5,"front-left quarter view"]],
            elevation: [[-15,"low-angle shot"],[15,"eye-level shot"],[45,"elevated shot"]],
            distance: [[2,"wide shot"],[6,"medium shot"]],
        };
    }
    return _promptRules;
}

fetchPromptRules();

function _resolveDirection(angle, rules, wrap360) {
    if (wrap360) {
        const a = ((angle % 360) + 360) % 360;
        for (let i = 0; i < rules.length; i++) {
            const [bound, label] = rules[i];
            if (i === 0 ? a >= bound : a < bound) return label;
        }
        return rules[rules.length - 1][1];
    }
    for (let i = rules.length - 1; i >= 0; i--) {
        if (angle >= rules[i][0]) return rules[i][1];
    }
    return rules[0][1];
}

function generatePrompt(azimuth, elevation, distance) {
    const rules = _promptRules || {
        azimuth: [[337.5,"front view"],[22.5,"front view"],[67.5,"front-right quarter view"],[112.5,"right side view"],[157.5,"back-right quarter view"],[202.5,"back view"],[247.5,"back-left quarter view"],[292.5,"left side view"],[337.5,"front-left quarter view"]],
        elevation: [[-15,"low-angle shot"],[15,"eye-level shot"],[45,"elevated shot"]],
        distance: [[2,"wide shot"],[6,"medium shot"]],
    };
    const hDir = _resolveDirection(azimuth, rules.azimuth, true);
    const vDir = _resolveDirection(elevation, rules.elevation, false);
    const dist = _resolveDirection(distance, rules.distance, false);
    return `<sks> ${hDir} ${vDir} ${dist}`;
}

// ─── Dropdown options ───────────────────────────────────────────────────────

const AZIMUTH_OPTIONS = [
    { key: "frontView", value: 0 }, { key: "frontRightQuarterView", value: 45 },
    { key: "rightSideView", value: 90 }, { key: "backRightQuarterView", value: 135 },
    { key: "backView", value: 180 }, { key: "backLeftQuarterView", value: 225 },
    { key: "leftSideView", value: 270 }, { key: "frontLeftQuarterView", value: 315 },
];

const ELEVATION_OPTIONS = [
    { key: "lowAngleShot", value: -30 }, { key: "eyeLevelShot", value: 0 },
    { key: "elevatedShot", value: 30 }, { key: "highAngleShot", value: 60 },
];

const DISTANCE_OPTIONS = [
    { key: "wideShot", value: 1 }, { key: "mediumShot", value: 4 }, { key: "closeUp", value: 8 },
];

// ─── CameraWidget (Three.js engine) ─────────────────────────────────────────

class CameraWidget {
    constructor(container, initialState, onStateChange) {
        this.container = container;
        this.onStateChange = onStateChange;
        this.azimuth = initialState?.azimuth ?? 0;
        this.elevation = initialState?.elevation ?? 0;
        this.distance = initialState?.distance ?? 5;
        this.imageUrl = initialState?.imageUrl ?? null;

        this.liveAzimuth = this.azimuth;
        this.liveElevation = this.elevation;
        this.liveDistance = this.distance;

        this.isDragging = false;
        this.dragTarget = null;
        this.hoveredHandle = null;
        this.useCameraView = false;
        this.isOrbitDragging = false;
        this.orbitStartX = 0;
        this.orbitStartY = 0;
        this.orbitStartAzimuth = 0;
        this.orbitStartElevation = 0;
        this.animationId = null;
        this.time = 0;
        this.disposed = false;

        this.CENTER = new THREE.Vector3(0, 0.5, 0);
        this.AZIMUTH_RADIUS = 1.8;
        this.ELEVATION_RADIUS = 1.4;
        this.ELEV_ARC_X = -0.8;

        this._initThreeJS();
        this._bindEvents();
        this._animate();
    }

    _initThreeJS() {
        const width = this.container.clientWidth || 300;
        const height = this.container.clientHeight || 300;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        this.camera.position.set(4, 3.5, 4);
        this.camera.lookAt(0, 0.3, 0);

        this.previewCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
        this.activeCamera = this.camera;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.container.appendChild(this.renderer.domElement);

        const canvas = this.renderer.domElement;
        canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%";

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
        const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
        mainLight.position.set(5, 10, 5);
        this.scene.add(mainLight);
        const fillLight = new THREE.DirectionalLight(0xe93d82, 0.3);
        fillLight.position.set(-5, 5, -5);
        this.scene.add(fillLight);

        const grid = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
        grid.position.y = -0.01;
        this.scene.add(grid);

        this._createSubject();
        this._createCameraIndicator();
        this._createAzimuthRing();
        this._createElevationArc();
        this._createDistanceHandle();
        this._updateVisuals();
    }

    _createCanvasTexture(drawText) {
        const size = 256;
        const cvs = document.createElement("canvas");
        cvs.width = size;
        cvs.height = size;
        const ctx = cvs.getContext("2d");
        ctx.fillStyle = "#1a1a2a";
        ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = "#2a2a3a";
        ctx.lineWidth = 1;
        for (let i = 0; i <= size; i += 16) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
        }
        if (drawText) {
            ctx.fillStyle = "#3a3a5a";
            ctx.font = "bold 48px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("背面", size / 2, size / 2);
            return new THREE.CanvasTexture(cvs);
        }
        const tex = new THREE.CanvasTexture(cvs);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(4, 4);
        return tex;
    }

    _createSubject() {
        const cardGeo = new THREE.BoxGeometry(0.8, 0.8, 0.02);
        const frontMat = new THREE.MeshBasicMaterial({ color: 0x3a3a4a, toneMapped: false });
        const backMat = new THREE.MeshBasicMaterial({ map: this._createCanvasTexture(true), toneMapped: false });
        const edgeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a2a });
        this.imagePlane = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, backMat]);
        this.imagePlane.position.copy(this.CENTER);
        this.scene.add(this.imagePlane);
        this.planeMat = frontMat;

        const frameGeo = new THREE.EdgesGeometry(cardGeo);
        this.imageFrame = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color: 0xe93d82 }));
        this.imageFrame.position.copy(this.CENTER);
        this.scene.add(this.imageFrame);

        const glowRingGeo = new THREE.RingGeometry(0.38, 0.40, 64);
        this.glowRing = new THREE.Mesh(glowRingGeo, new THREE.MeshBasicMaterial({
            color: 0xe93d82, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
        }));
        this.glowRing.position.set(0, 0.01, 0);
        this.glowRing.rotation.x = -Math.PI / 2;
        this.scene.add(this.glowRing);
    }

    _createCameraIndicator() {
        this.cameraIndicator = new THREE.Mesh(
            new THREE.ConeGeometry(0.15, 0.4, 4),
            new THREE.MeshStandardMaterial({
                color: 0xe93d82, emissive: 0xe93d82, emissiveIntensity: 0.5,
                metalness: 0.8, roughness: 0.2,
            }),
        );
        this.scene.add(this.cameraIndicator);

        this.camGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.camGlow);
    }

    _createHandle(geo, color, emissiveIntensity) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity,
            metalness: 0.3, roughness: 0.4,
        }));
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 16, 16),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2 }),
        );
        this.scene.add(mesh);
        this.scene.add(glow);
        return { mesh, glow };
    }

    _createAzimuthRing() {
        this.azimuthRing = new THREE.Mesh(
            new THREE.TorusGeometry(this.AZIMUTH_RADIUS, 0.04, 16, 100),
            new THREE.MeshBasicMaterial({ color: 0xe93d82, transparent: true, opacity: 0.7 }),
        );
        this.azimuthRing.rotation.x = Math.PI / 2;
        this.azimuthRing.position.y = 0.02;
        this.scene.add(this.azimuthRing);

        const { mesh, glow } = this._createHandle(
            new THREE.SphereGeometry(0.16, 32, 32), 0xe93d82, 0.6,
        );
        this.azimuthHandle = mesh;
        this.azGlow = glow;
    }

    _createElevationArc() {
        const points = [];
        for (let i = 0; i <= 32; i++) {
            const angle = (-30 + (90 * i / 32)) * Math.PI / 180;
            points.push(new THREE.Vector3(
                this.ELEV_ARC_X,
                this.ELEVATION_RADIUS * Math.sin(angle) + this.CENTER.y,
                this.ELEVATION_RADIUS * Math.cos(angle),
            ));
        }
        this.elevationArc = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, 0.04, 8, false),
            new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.elevationArc);

        const { mesh, glow } = this._createHandle(
            new THREE.SphereGeometry(0.16, 32, 32), 0x00ffd0, 0.6,
        );
        this.elevationHandle = mesh;
        this.elGlow = glow;
    }

    _createDistanceHandle() {
        const { mesh, glow } = this._createHandle(
            new THREE.SphereGeometry(0.15, 32, 32), 0xffb800, 0.7,
        );
        this.distanceHandle = mesh;
        this.distGlow = glow;
        this.distanceTube = null;
    }

    _updateDistanceLine(start, end) {
        if (this.distanceTube) {
            this.scene.remove(this.distanceTube);
            this.distanceTube.geometry.dispose();
            this.distanceTube.material.dispose();
        }
        this.distanceTube = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.LineCurve3(start, end), 1, 0.025, 8, false),
            new THREE.MeshBasicMaterial({ color: 0xffb800, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.distanceTube);
    }

    _updateVisuals() {
        const azRad = (this.liveAzimuth * Math.PI) / 180;
        const elRad = (this.liveElevation * Math.PI) / 180;
        const visualDist = 2.6 - (this.liveDistance / 10) * 2.0;

        const cosEl = Math.cos(elRad);
        const sinEl = Math.sin(elRad);
        const sinAz = Math.sin(azRad);
        const cosAz = Math.cos(azRad);

        // Camera indicator
        const camX = visualDist * sinAz * cosEl;
        const camY = this.CENTER.y + visualDist * sinEl;
        const camZ = visualDist * cosAz * cosEl;
        this.cameraIndicator.position.set(camX, camY, camZ);
        this.cameraIndicator.lookAt(this.CENTER);
        this.cameraIndicator.rotateX(Math.PI / 2);
        this.camGlow.position.copy(this.cameraIndicator.position);

        // Azimuth handle
        this.azimuthHandle.position.set(this.AZIMUTH_RADIUS * sinAz, 0.16, this.AZIMUTH_RADIUS * cosAz);
        this.azGlow.position.copy(this.azimuthHandle.position);

        // Elevation handle
        this.elevationHandle.position.set(this.ELEV_ARC_X, this.CENTER.y + this.ELEVATION_RADIUS * sinEl, this.ELEVATION_RADIUS * cosEl);
        this.elGlow.position.copy(this.elevationHandle.position);

        // Distance handle
        const distT = 0.15 + ((10 - this.liveDistance) / 10) * 0.7;
        this.distanceHandle.position.lerpVectors(this.CENTER, this.cameraIndicator.position, distT);
        this.distGlow.position.copy(this.distanceHandle.position);

        this._updateDistanceLine(this.CENTER.clone(), this.cameraIndicator.position.clone());

        // Preview camera (pulled back for smaller subject)
        const previewDist = visualDist * 2.5;
        this.previewCamera.position.set(
            previewDist * sinAz * cosEl,
            this.CENTER.y + previewDist * sinEl,
            previewDist * cosAz * cosEl,
        );
        this.previewCamera.lookAt(this.CENTER);

        this.glowRing.rotation.z += 0.005;
    }

    _bindEvents() {
        const canvas = this.renderer.domElement;
        canvas.addEventListener("mousedown", (e) => this._onPointerDown(e));
        canvas.addEventListener("mousemove", (e) => this._onPointerMove(e));
        canvas.addEventListener("mouseup", () => this._onPointerUp());
        canvas.addEventListener("mouseleave", () => this._onPointerUp());
        canvas.addEventListener("touchstart", (e) => {
            e.preventDefault();
            this._onPointerDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        }, { passive: false });
        canvas.addEventListener("touchmove", (e) => {
            e.preventDefault();
            this._onPointerMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        }, { passive: false });
        canvas.addEventListener("touchend", () => this._onPointerUp());
        canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(this.container);
    }

    _getMousePos(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this._mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    _setHandleScale(handle, glow, scale) {
        handle.scale.setScalar(scale);
        if (glow) glow.scale.setScalar(scale);
    }

    _applyAzimuthDelta(delta) {
        this.liveAzimuth = ((this.liveAzimuth + delta) % 360 + 360) % 360;
        this.azimuth = Math.round(this.liveAzimuth);
    }

    _applyElevationDelta(delta) {
        this.liveElevation = Math.max(-30, Math.min(60, this.liveElevation + delta));
        this.elevation = Math.round(this.liveElevation);
    }

    _onPointerDown(event) {
        this._getMousePos(event);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(this._mouseX, this._mouseY), this.camera);

        if (this.useCameraView) {
            this.isOrbitDragging = true;
            this.orbitStartX = event.clientX;
            this.orbitStartY = event.clientY;
            this.orbitStartAzimuth = this.liveAzimuth;
            this.orbitStartElevation = this.liveElevation;
            this.renderer.domElement.style.cursor = "grabbing";
            this.renderer.domElement.requestPointerLock();
            return;
        }

        const handles = [
            { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
            { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
            { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
        ];
        for (const h of handles) {
            if (raycaster.intersectObject(h.mesh).length > 0) {
                this.isDragging = true;
                this.dragTarget = h.name;
                this._setHandleScale(h.mesh, h.glow, 1.3);
                this.renderer.domElement.style.cursor = "grabbing";
                return;
            }
        }
    }

    _onPointerMove(event) {
        this._getMousePos(event);
        const mouse = new THREE.Vector2(this._mouseX, this._mouseY);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        if (this.useCameraView && this.isOrbitDragging) {
            const sensitivity = 0.5;
            if (document.pointerLockElement === this.renderer.domElement && event.movementX !== undefined) {
                this._applyAzimuthDelta(-event.movementX * sensitivity);
                this._applyElevationDelta(event.movementY * sensitivity);
            } else {
                this._applyAzimuthDelta(-(event.clientX - this.orbitStartX) * sensitivity);
                this._applyElevationDelta((event.clientY - this.orbitStartY) * sensitivity);
                this.orbitStartX = event.clientX;
                this.orbitStartY = event.clientY;
            }
            this._updateVisuals();
            this._notifyStateChange();
            return;
        }

        if (!this.isDragging) {
            const handles = [
                { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
                { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
                { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
            ];
            let foundHover = null;
            for (const h of handles) {
                if (raycaster.intersectObject(h.mesh).length > 0) { foundHover = h; break; }
            }
            if (this.hoveredHandle && this.hoveredHandle !== foundHover) {
                this._setHandleScale(this.hoveredHandle.mesh, this.hoveredHandle.glow, 1.0);
            }
            if (foundHover) {
                this._setHandleScale(foundHover.mesh, foundHover.glow, 1.15);
                this.renderer.domElement.style.cursor = "grab";
            } else {
                this.renderer.domElement.style.cursor = "default";
            }
            this.hoveredHandle = foundHover;
            return;
        }

        // Dragging logic
        raycaster.setFromCamera(mouse, this.activeCamera);
        if (this.dragTarget === "azimuth") {
            const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.16);
            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(plane, intersection)) {
                let angle = Math.atan2(intersection.x, intersection.z) * 180 / Math.PI;
                if (angle < 0) angle += 360;
                this.liveAzimuth = angle;
                this.azimuth = Math.round(angle);
            }
        } else if (this.dragTarget === "elevation") {
            const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -this.ELEV_ARC_X);
            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(plane, intersection)) {
                let angle = Math.atan2(intersection.y - this.CENTER.y, intersection.z) * 180 / Math.PI;
                angle = Math.max(-30, Math.min(60, angle));
                this.liveElevation = angle;
                this.elevation = Math.round(angle);
            }
        } else if (this.dragTarget === "distance") {
            const dir = new THREE.Vector3().subVectors(this.cameraIndicator.position, this.CENTER);
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.normalize(), this.CENTER);
            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(plane, intersection)) {
                const dist = intersection.distanceTo(this.CENTER);
                const t = Math.max(0, Math.min(1, (dist - 0.6) / 2.0));
                this.liveDistance = Math.max(0, Math.min(10, 10 - t * 10));
                this.distance = Math.round(this.liveDistance * 10) / 10;
            }
        }

        this._updateVisuals();
        this._notifyStateChange();
    }

    _onPointerUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragTarget = null;
            this._setHandleScale(this.azimuthHandle, this.azGlow, 1.0);
            this._setHandleScale(this.elevationHandle, this.elGlow, 1.0);
            this._setHandleScale(this.distanceHandle, this.distGlow, 1.0);
        }
        if (this.isOrbitDragging) this.isOrbitDragging = false;
        if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
        this.renderer.domElement.style.cursor = "default";
    }

    _onWheel(event) {
        event.preventDefault();
        if (!this.useCameraView) return;
        const delta = event.deltaY > 0 ? -0.5 : 0.5;
        this.liveDistance = Math.max(0, Math.min(10, this.liveDistance + delta));
        this.distance = Math.round(this.liveDistance * 10) / 10;
        this._updateVisuals();
        this._notifyStateChange();
    }

    _onResize() {
        const width = this.container.clientWidth || 300;
        const height = this.container.clientHeight || 300;
        if (width < 1 || height < 1) return;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.previewCamera.aspect = width / height;
        this.previewCamera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    _animate() {
        if (this.disposed) return;
        this.animationId = requestAnimationFrame(() => this._animate());
        this.time += 0.016;
        this.renderer.render(this.scene, this.activeCamera);
    }

    _notifyStateChange() {
        this.onStateChange?.({
            azimuth: this.azimuth,
            elevation: this.elevation,
            distance: this.distance,
            imageUrl: this.imageUrl,
        });
    }

    // Public API

    setState(state) {
        if (state.azimuth !== undefined) { this.azimuth = state.azimuth; this.liveAzimuth = state.azimuth; }
        if (state.elevation !== undefined) { this.elevation = state.elevation; this.liveElevation = state.elevation; }
        if (state.distance !== undefined) { this.distance = state.distance; this.liveDistance = state.distance; }
        this._updateVisuals();
    }

    setCameraView(enabled) {
        this.useCameraView = enabled;
        this.activeCamera = enabled ? this.previewCamera : this.camera;
        const vis = !enabled;
        this.azimuthRing.visible = vis;
        this.azimuthHandle.visible = vis;
        this.azGlow.visible = vis;
        this.elevationArc.visible = vis;
        this.elevationHandle.visible = vis;
        this.elGlow.visible = vis;
        this.distanceHandle.visible = vis;
        this.distGlow.visible = vis;
        if (this.distanceTube) this.distanceTube.visible = vis;
        this.cameraIndicator.visible = vis;
        this.camGlow.visible = vis;
        this.glowRing.visible = vis;
        this.imageFrame.visible = vis;
    }

    updateImage(url) {
        this.imageUrl = url;
        if (!url) {
            this.planeMat.map = null;
            this.planeMat.color.set(0x3a3a4a);
            this.planeMat.needsUpdate = true;
            this.imagePlane.scale.set(1, 1, 1);
            this.imageFrame.scale.set(1, 1, 1);
            return;
        }
        new THREE.TextureLoader().load(url, (tex) => {
            if (this.disposed) return;
            tex.colorSpace = THREE.SRGBColorSpace;
            this.planeMat.map = tex;
            this.planeMat.color.set(0xffffff);
            this.planeMat.needsUpdate = true;
            const img = tex.image;
            if (img && img.width && img.height) {
                const aspect = img.width / img.height;
                // Wide: keep height; Tall: keep width
                const sx = aspect >= 1 ? aspect : 1;
                const sy = aspect >= 1 ? 1 : 1 / aspect;
                this.imagePlane.scale.set(sx, sy, 1);
                this.imageFrame.scale.set(sx, sy, 1);
            }
        });
    }

    generatePrompt() {
        return generatePrompt(this.azimuth, this.elevation, this.distance);
    }

    dispose() {
        this.disposed = true;
        if (this.animationId !== null) cancelAnimationFrame(this.animationId);
        this._resizeObserver?.disconnect();
        this.renderer.dispose();
        if (this.container.contains(this.renderer.domElement)) {
            this.container.removeChild(this.renderer.domElement);
        }
    }
}

// ─── DOM UI Builder ─────────────────────────────────────────────────────────

function buildControlPanel() {
    const panel = document.createElement("div");
    panel.className = "qwen-ctrl-panel";

    function makeDropdown(label, options, onChange) {
        const wrap = document.createElement("div");
        wrap.className = "qwen-ctrl-wrap";
        const lbl = document.createElement("span");
        lbl.className = "qwen-ctrl-label";
        lbl.textContent = label;
        const sel = document.createElement("select");
        sel.className = "qwen-ctrl-select";
        for (const opt of options) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = t(opt.key);
            sel.appendChild(o);
        }
        sel.addEventListener("change", () => onChange(parseFloat(sel.value)));
        wrap.appendChild(lbl);
        wrap.appendChild(sel);
        return { wrap, sel, lbl };
    }

    const row1 = document.createElement("div");
    row1.className = "qwen-ctrl-row";

    const azDD = makeDropdown(t("horizontal"), AZIMUTH_OPTIONS, (v) => panel._onAxisChange?.("azimuth", v));
    azDD.lbl.classList.add("azimuth");
    azDD.sel.classList.add("azimuth");

    const elDD = makeDropdown(t("vertical"), ELEVATION_OPTIONS, (v) => panel._onAxisChange?.("elevation", v));
    elDD.lbl.classList.add("elevation");
    elDD.sel.classList.add("elevation");

    const distDD = makeDropdown(t("distance"), DISTANCE_OPTIONS, (v) => panel._onAxisChange?.("distance", v));
    distDD.lbl.classList.add("distance");
    distDD.sel.classList.add("distance");

    row1.appendChild(azDD.wrap);
    row1.appendChild(elDD.wrap);
    row1.appendChild(distDD.wrap);

    const row2 = document.createElement("div");
    row2.className = "qwen-ctrl-row";

    const makeVal = (cls, text) => {
        const el = document.createElement("div");
        el.className = `qwen-ctrl-val ${cls}`;
        el.textContent = text;
        return el;
    };
    const azVal = makeVal("azimuth", "0°");
    const elVal = makeVal("elevation", "0°");
    const distVal = makeVal("distance", "5.0");

    const resetBtn = document.createElement("button");
    resetBtn.className = "qwen-ctrl-reset";
    resetBtn.textContent = "↺";
    resetBtn.title = t("resetToDefaults");
    resetBtn.addEventListener("click", () => panel._onReset?.());

    row2.appendChild(azVal);
    row2.appendChild(elVal);
    row2.appendChild(distVal);
    row2.appendChild(resetBtn);

    panel.appendChild(row1);
    panel.appendChild(row2);

    panel._azSelect = azDD.sel;
    panel._elSelect = elDD.sel;
    panel._distSelect = distDD.sel;
    panel._azVal = azVal;
    panel._elVal = elVal;
    panel._distVal = distVal;

    return panel;
}

// ─── Instance management ────────────────────────────────────────────────────

const PROP_KEY = "qwenCameraState";
const instances = new WeakMap();
const CLEANUP_DELAY_MS = 200;

function getWidgetValue(node, name, defaultVal) {
    const w = node.widgets?.find((w) => w.name === name);
    return w ? Number(w.value) : defaultVal;
}

function readStoredProps(node) {
    const raw = node.properties?.[PROP_KEY];
    return raw && typeof raw === "object" ? raw : null;
}

function writeStoredProps(node, patch) {
    if (!node.properties) node.properties = {};
    node.properties[PROP_KEY] = { ...node.properties[PROP_KEY], ...patch };
}

function readStateFromNode(node) {
    const stored = readStoredProps(node);
    return {
        azimuth: stored?.azimuth ?? getWidgetValue(node, "horizontal_angle", 0),
        elevation: stored?.elevation ?? getWidgetValue(node, "vertical_angle", 0),
        distance: stored?.distance ?? getWidgetValue(node, "zoom", 5.0),
    };
}

function readCameraViewFromNode(node) {
    const stored = readStoredProps(node);
    if (stored?.cameraView !== undefined) return Boolean(stored.cameraView);
    return Boolean(node.widgets?.find((w) => w.name === "camera_view")?.value);
}

function syncWidgetsFromState(node, state) {
    const map = { horizontal_angle: "azimuth", vertical_angle: "elevation", zoom: "distance", camera_view: "cameraView" };
    for (const [wName, sKey] of Object.entries(map)) {
        if (state[sKey] === undefined) continue;
        const w = node.widgets?.find((w) => w.name === wName);
        if (w) w.value = state[sKey];
    }
}

function findClosestOption(value, options, wrap360 = false) {
    let closest = options[0].value;
    let minDiff = Infinity;
    for (const opt of options) {
        let diff = Math.abs(value - opt.value);
        if (wrap360) diff = Math.min(diff, Math.abs(value - opt.value - 360), Math.abs(value - opt.value + 360));
        if (diff < minDiff) { minDiff = diff; closest = opt.value; }
    }
    return closest;
}

function updateControlPanel(panel, azimuth, elevation, distance) {
    panel._azSelect.value = findClosestOption(azimuth, AZIMUTH_OPTIONS, true);
    panel._elSelect.value = findClosestOption(elevation, ELEVATION_OPTIONS);
    panel._distSelect.value = findClosestOption(distance, DISTANCE_OPTIONS);
    panel._azVal.textContent = `${Math.round(azimuth)}°`;
    panel._elVal.textContent = `${Math.round(elevation)}°`;
    panel._distVal.textContent = distance.toFixed(1);
}

function createInstance(node) {
    const container = document.createElement("div");
    container.className = "qwen-container";

    const sceneContainer = document.createElement("div");
    sceneContainer.className = "qwen-scene";
    container.appendChild(sceneContainer);

    const promptOverlay = document.createElement("div");
    promptOverlay.className = "qwen-prompt-overlay";
    sceneContainer.appendChild(promptOverlay);

    const controlPanel = buildControlPanel();
    sceneContainer.appendChild(controlPanel);

    const initialState = readStateFromNode(node);

    const instance = {
        container, sceneContainer, promptOverlay, controlPanel,
        widget: null, cameraWidget: null, currentNode: node,
        cleanupTimer: null, initialized: false,
    };

    promptOverlay.textContent = generatePrompt(initialState.azimuth, initialState.elevation, initialState.distance);
    updateControlPanel(controlPanel, initialState.azimuth, initialState.elevation, initialState.distance);

    // Unified axis change handler
    controlPanel._onAxisChange = (axis, value) => {
        const cw = instance.cameraWidget;
        const state = cw ? { azimuth: cw.azimuth, elevation: cw.elevation, distance: cw.distance } : initialState;
        state[axis] = value;
        if (cw) cw.setState({ [axis]: value });
        promptOverlay.textContent = generatePrompt(state.azimuth, state.elevation, state.distance);
        updateControlPanel(controlPanel, state.azimuth, state.elevation, state.distance);
        syncWidgetsFromState(node, { [axis]: value });
        writeStoredProps(node, { [axis]: value });
        app.graph?.setDirtyCanvas(true, true);
    };

    controlPanel._onReset = () => {
        const defaults = { azimuth: 0, elevation: 0, distance: 5 };
        if (instance.cameraWidget) instance.cameraWidget.setState(defaults);
        promptOverlay.textContent = generatePrompt(0, 0, 5);
        updateControlPanel(controlPanel, 0, 0, 5);
        syncWidgetsFromState(node, defaults);
        writeStoredProps(node, defaults);
        app.graph?.setDirtyCanvas(true, true);
    };

    instances.set(node, instance);
    return instance;
}

function initCameraWidget(instance, node) {
    if (instance.initialized) return;

    const MAX_INIT_RETRIES = 60;
    let retries = 0;

    const tryInit = () => {
        const w = instance.sceneContainer.clientWidth;
        const h = instance.sceneContainer.clientHeight;
        if (w > 0 && h > 0) {
            doInit();
        } else if (retries < MAX_INIT_RETRIES) {
            retries++;
            requestAnimationFrame(tryInit);
        } else {
            console.warn("[QwenMultiangleCamera] Container has no dimensions, using defaults");
            doInit();
        }
    };

    const doInit = () => {
        instance.initialized = true;
        const state = readStateFromNode(node);

        const cameraWidget = new CameraWidget(instance.sceneContainer, state, (newState) => {
            syncWidgetsFromState(instance.currentNode, newState);
            writeStoredProps(instance.currentNode, newState);
            instance.promptOverlay.textContent = cameraWidget.generatePrompt();
            updateControlPanel(instance.controlPanel, newState.azimuth, newState.elevation, newState.distance);
            app.graph?.setDirtyCanvas(true, true);
        });

        instance.cameraWidget = cameraWidget;
        instance.promptOverlay.textContent = cameraWidget.generatePrompt();
        updateControlPanel(instance.controlPanel, state.azimuth, state.elevation, state.distance);

        if (readCameraViewFromNode(node)) cameraWidget.setCameraView(true);

        bindWidgetCallbacks(node, instance);
    };

    requestAnimationFrame(tryInit);
}

function bindWidgetCallbacks(node, instance) {
    const axisMap = [
        { widget: "horizontal_angle", axis: "azimuth" },
        { widget: "vertical_angle", axis: "elevation" },
        { widget: "zoom", axis: "distance" },
    ];

    for (const { widget: wName, axis } of axisMap) {
        const w = node.widgets?.find((w) => w.name === wName);
        if (!w) continue;
        const origCallback = w.callback;
        w.callback = (value) => {
            origCallback?.call(w, value);
            const v = Number(value);
            instance.cameraWidget.setState({ [axis]: v });
            writeStoredProps(node, { [axis]: v });
            instance.promptOverlay.textContent = instance.cameraWidget.generatePrompt();
            const cw = instance.cameraWidget;
            updateControlPanel(instance.controlPanel, cw.azimuth, cw.elevation, cw.distance);
        };
    }

    const cvWidget = node.widgets?.find((w) => w.name === "camera_view");
    if (cvWidget) {
        const origCallback = cvWidget.callback;
        cvWidget.callback = (value) => {
            origCallback?.call(cvWidget, value);
            instance.cameraWidget.setCameraView(Boolean(value));
            writeStoredProps(node, { cameraView: Boolean(value) });
        };
    }
}

function createCameraWidget(node) {
    let instance = instances.get(node);
    if (instance) {
        if (instance.cleanupTimer !== null) {
            clearTimeout(instance.cleanupTimer);
            instance.cleanupTimer = null;
        }
        instance.currentNode = node;
        if (instance.cameraWidget) {
            const state = readStateFromNode(node);
            instance.cameraWidget.setState(state);
            instance.cameraWidget.setCameraView(readCameraViewFromNode(node));
            instance.promptOverlay.textContent = instance.cameraWidget.generatePrompt();
            updateControlPanel(instance.controlPanel, state.azimuth, state.elevation, state.distance);
        }
    } else {
        instance = createInstance(node);
    }

    const widget = node.addDOMWidget("camera_preview", "qwen-multiangle", instance.container, {
        getMinHeight: () => 400,
        getHeight: () => instance.container.clientHeight || 400,
        hideOnZoom: false,
        serialize: false,
    });

    instance.widget = widget;
    widget.computeSize = () => [320, 400];

    const origOnResize = node.onResize?.bind(node);
    node.onResize = function () {
        origOnResize?.call(this);
        requestAnimationFrame(() => updateContainerHeight());
    };

    function updateContainerHeight() {
        const parent = instance.container.parentElement;
        if (!parent) return;
        let topOffset = 0;
        if (node.widgets) {
            for (const w of node.widgets) {
                if (w === widget) { topOffset = w.last_y || 0; break; }
            }
        }
        const available = Math.max(200, node.size[1] - 20 - topOffset);
        instance.container.style.height = available + "px";
    }

    requestAnimationFrame(() => requestAnimationFrame(() => {
        updateContainerHeight();
        node.setDirtyCanvas(true, true);
    }));

    const baseOnRemove = widget.onRemove?.bind(widget);
    widget.onRemove = () => {
        baseOnRemove?.();
        const current = instances.get(node);
        if (!current || current.widget !== widget) return;
        current.cleanupTimer = window.setTimeout(() => {
            const still = instances.get(node);
            if (!still || still.widget !== widget) return;
            still.cameraWidget?.dispose();
            instances.delete(node);
        }, CLEANUP_DELAY_MS);
    };

    return widget;
}

function setupImageInput(node) {
    const origOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (slotType, slotIndex, isConnected, link, ioSlot) {
        origOnConnectionsChange?.call(this, slotType, slotIndex, isConnected, link, ioSlot);
        if (slotType === 1 && slotIndex === 0) {
            const inst = instances.get(node);
            if (inst?.cameraWidget && !isConnected) inst.cameraWidget.updateImage(null);
        }
    };
}

function setupOnExecuted(node, instance) {
    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.call(this, output);
        if (!instance.cameraWidget || !output || typeof output !== "object") return;

        // Source 1: base64 from Python
        const b64 = output.image_base64;
        if (b64?.length > 0 && b64[0]) {
            instance.cameraWidget.updateImage(b64[0]);
            return;
        }

        // Source 2: ComfyUI /view endpoint
        const images = output.preview_images || output.images;
        if (images?.length > 0) {
            const img = images[0];
            const params = new URLSearchParams({
                filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output",
            });
            instance.cameraWidget.updateImage(api.apiURL(`/view?${params.toString()}`));
        }
    };
}

function setupOnPropertyChanged(node, instance) {
    const origOnPropertyChanged = node.onPropertyChanged;
    node.onPropertyChanged = function (key, value) {
        origOnPropertyChanged?.call(this, key, value);
        if (key !== PROP_KEY || !value || typeof value !== "object" || !instance.cameraWidget) return;
        instance.cameraWidget.setState({
            azimuth: value.azimuth, elevation: value.elevation, distance: value.distance,
        });
        if (value.cameraView !== undefined) instance.cameraWidget.setCameraView(Boolean(value.cameraView));
        syncWidgetsFromState(node, value);
        instance.promptOverlay.textContent = instance.cameraWidget.generatePrompt();
        updateControlPanel(instance.controlPanel, value.azimuth ?? 0, value.elevation ?? 0, value.distance ?? 5);
    };
}

// ─── ComfyUI Extension Registration ─────────────────────────────────────────

app.registerExtension({
    name: "ComfyUI_BrotherPao.QwenMultiangleCamera",

    nodeCreated(node) {
        if (node.constructor?.comfyClass !== "BrotherPao_QwenMultiangleCamera") return;

        const [oldWidth, oldHeight] = node.size;
        node.setSize([Math.max(oldWidth, 320), Math.max(oldHeight, 500)]);

        createCameraWidget(node);
        setupImageInput(node);

        const inst = instances.get(node);
        if (inst) {
            setupOnExecuted(node, inst);
            setupOnPropertyChanged(node, inst);
        }

        loadThreeJS().then(() => {
            if (inst && !inst.initialized) initCameraWidget(inst, node);
        }).catch((err) => {
            console.error("[QwenMultiangleCamera] Three.js load failed:", err);
            if (inst) {
                inst.promptOverlay.textContent = "Three.js 加载失败，请检查网络连接";
                inst.promptOverlay.style.color = "#ff4444";
            }
        });
    },
});

// ─── Inject CSS ─────────────────────────────────────────────────────────────

(function injectCSS() {
    const style = document.createElement("style");
    style.textContent = `
.qwen-container {
    width: 100%;
    height: 100%;
    position: relative;
    background: #0a0a0f;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    border-radius: 4px;
    overflow: hidden;
}
.qwen-scene {
    width: 100%;
    height: 100%;
    min-height: 150px;
    position: relative;
}
.qwen-prompt-overlay {
    position: absolute;
    top: 4px;
    left: 4px;
    right: 4px;
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid rgba(233, 61, 130, 0.3);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: #E93D82;
    backdrop-filter: blur(4px);
    font-family: 'Consolas', 'Monaco', monospace;
    word-break: break-all;
    line-height: 1.4;
    pointer-events: none;
    z-index: 10;
}
.qwen-ctrl-panel {
    position: absolute;
    bottom: 4px;
    left: 4px;
    right: 4px;
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid rgba(233, 61, 130, 0.3);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: #e0e0e0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    backdrop-filter: blur(4px);
    z-index: 10;
}
.qwen-ctrl-row {
    display: flex;
    justify-content: space-around;
    align-items: center;
}
.qwen-ctrl-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
}
.qwen-ctrl-label {
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
}
.qwen-ctrl-label.azimuth { color: #E93D82; }
.qwen-ctrl-label.elevation { color: #00FFD0; }
.qwen-ctrl-label.distance { color: #FFB800; }
.qwen-ctrl-select {
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid rgba(100, 100, 120, 0.4);
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 9px;
    color: #e0e0e0;
    cursor: pointer;
    outline: none;
    max-width: 90px;
    backdrop-filter: blur(4px);
}
.qwen-ctrl-select:hover { border-color: rgba(150, 150, 170, 0.6); }
.qwen-ctrl-select:focus { border-color: #E93D82; }
.qwen-ctrl-select.azimuth:focus { border-color: #E93D82; }
.qwen-ctrl-select.elevation:focus { border-color: #00FFD0; }
.qwen-ctrl-select.distance:focus { border-color: #FFB800; }
.qwen-ctrl-select option { background: #1a1a2e; color: #e0e0e0; }
.qwen-ctrl-val {
    font-weight: 600;
    font-size: 13px;
    text-align: center;
}
.qwen-ctrl-val.azimuth { color: #E93D82; }
.qwen-ctrl-val.elevation { color: #00FFD0; }
.qwen-ctrl-val.distance { color: #FFB800; }
.qwen-ctrl-reset {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: 1px solid rgba(233, 61, 130, 0.4);
    background: rgba(10, 10, 15, 0.8);
    color: #E93D82;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all 0.2s ease;
    flex-shrink: 0;
}
.qwen-ctrl-reset:hover {
    background: rgba(233, 61, 130, 0.2);
    border-color: #E93D82;
}
.qwen-ctrl-reset:active { transform: scale(0.95); }
`;
    document.head.appendChild(style);
})();
