/**
 * 세라젬 V11 WebXR 컨트롤 스크립트
 * ---------------------------------------------------------------------------
 * 1) root/ref/ar-barebones.html에서 확인한 WebXR 세션 흐름을 주석으로 정리하고,
 *    실제 구현은 <model-viewer>의 enterAR() 파이프라인을 그대로 활용한다.
 * 2) DOM Overlay 대신 화면 고정형(screen space) 핫스팟으로 버튼들을 구성하고,
 *    일정 시간 입력이 없으면 핫스팟을 서서히 숨겨 화면을 가리지 않도록 한다.
 * 3) AR 세션 상태에 따라 핫스팟 노출만 제어하며, 자동 회전 기능은 요구에 따라 제거되었다.
 * 4) 모델 회전은 Z축 기준으로만 적용해 AR 평면 리테일(바닥 표시)의 스케일이 틀어지지 않도록 한다.
 */

const modelViewer = document.querySelector("#catalog-viewer");
if (!modelViewer) {
  console.error("model-viewer 요소를 찾을 수 없습니다. HTML 구조를 확인하세요.");
}

const animationToggleButton = document.querySelector("#animation-toggle-button");
const animationThumb = document.querySelector("#animation-thumb");
const colorCycleButton = document.querySelector("#color-cycle-button");
const rotateButton = document.querySelector("#rotate-button");
const arButton = document.querySelector("#custom-ar-button");
const screenHotspots = Array.from(document.querySelectorAll(".screen-hotspot"));

/** 사용자 입력 후 핫스팟을 유지하는 시간(ms). */
const HOTSPOT_HIDE_DELAY = 3000;

/** 애니메이션 상태별 UI 속성. 썸네일 교체와 ARIA 레이블을 위한 매핑이다. */
const ANIMATION_STATE_MAP = {
  chair: { label: "체어 모드", thumb: "img/V11_thumbnail.webp" },
  stretch: { label: "스트레치 모드", thumb: "img/V11_stretch_thumbnail.webp" },
};

/** 텍스처 교체 시 순환할 URI 목록. 기본 텍스처는 null 로 표기한다. */
const TEXTURE_SEQUENCE = [
  { id: "original", label: "기본 텍스처", uri: null },
  { id: "beige", label: "CERA V11 Beige", uri: "texture/CERA_V11_low_D_Beige.png" },
  { id: "olive", label: "CERA V11 Olive", uri: "texture/CERA_V11_low_D_Olive.png" },
];

const textureCache = new Map();

let currentTextureIndex = 0;
let baseMaterial = null;
let baseColorTextureSlot = null;
let originalBaseTexture = null;
let chairAnimationName = null;
let stretchAnimationName = null;
let animationState = "chair";

const rotationState = {
  current: 0,
  from: 0,
  to: 0,
  startTime: null,
  raf: null,
};

/** 자동 회전 상태 */
const autoRotateState = {
  isActive: false,
  raf: null,
  lastTime: null,
  speed: 10, // 초당 회전 각도 (deg/s) - 느린 속도
};

let baseOrientation = { x: 0, y: 0, z: 0 };
let hotspotHideTimer = null;
let modelInitialized = false;

/** AR 모드 진입 시도 플래그 (AR 버튼 클릭 시 true) */
let arModeRequested = false;

/** AR 진입 전 회전값 저장 (AR 종료 시 복원용) */
let savedRotationBeforeAR = null;

/**
 * AR 모드 여부를 확인한다.
 * - model-viewer의 ar-status 속성 확인 (WebXR용)
 * - arModeRequested 플래그 확인 (Scene Viewer/Quick Look용)
 * - 페이지 visibility 확인 (앱 전환 감지)
 */
function checkIsInAR() {
  // AR 버튼이 클릭되어 AR 모드 진입 시도 중이면 true
  if (arModeRequested) {
    console.debug(`[AR Check] arModeRequested=true`);
    return true;
  }

  if (!modelViewer) return false;

  // model-viewer의 ar-status 속성 직접 확인 (WebXR)
  const arStatus = modelViewer.getAttribute("ar-status");
  const isAR = arStatus === "session-started" || arStatus === "object-placed";

  console.debug(`[AR Check] ar-status="${arStatus}", isInAR=${isAR}`);
  return isAR;
}

/**
 * beforexrselect 이벤트를 막아 AR 제스처와 UI 상호작용이 충돌하지 않도록 한다.
 * (WebXR DOM Overlays Module의 권장 사항)
 */
function preventXRSelect(event) {
  event.preventDefault();
}

screenHotspots.forEach((btn) => {
  btn.addEventListener("beforexrselect", preventXRSelect);
  btn.addEventListener("click", bumpHotspotVisibility);
});

[animationToggleButton, colorCycleButton, rotateButton]
  .filter(Boolean)
  .forEach((element) => {
    element.addEventListener("beforexrselect", preventXRSelect);
  });

/**
 * 핫스팟을 즉시 표시하고 자동 회전을 중단한다.
 * 사용자가 모델을 다시 조작할 준비가 되었음을 의미한다.
 */
function showScreenHotspots() {
  clearTimeout(hotspotHideTimer);
  stopAutoRotation();
  screenHotspots.forEach((btn) => btn.classList.remove("hotspot-hidden"));
}

/**
 * 일정 시간이 지나면 핫스팟을 숨기고, AR 모드가 아닐 때만 자동 회전을 시작한다.
 */
function scheduleHotspotHide(delay = HOTSPOT_HIDE_DELAY) {
  clearTimeout(hotspotHideTimer);
  hotspotHideTimer = setTimeout(() => {
    screenHotspots.forEach((btn) => btn.classList.add("hotspot-hidden"));
    // AR 모드에서는 자동 회전 비활성화 (실시간 체크)
    if (!checkIsInAR()) {
      startAutoRotation();
    }
  }, delay);
}

/**
 * 사용자 입력(클릭/터치 등) 시 호출하여 핫스팟 유지 시간을 초기화한다.
 */
function bumpHotspotVisibility() {
  showScreenHotspots();
  scheduleHotspotHide();
}

/**
 * 글로벌 포인터/터치 이벤트를 감지해 핫스팟 표시/숨김을 제어한다.
 * - 시작 이벤트: 즉시 표시
 * - 종료 이벤트: 일정 시간 후 숨김
 */
const globalStartEvents = ["pointerdown", "touchstart", "mousedown", "selectstart"];
const globalEndEvents = ["pointerup", "touchend", "mouseup", "pointercancel", "touchcancel", "selectend"];

globalStartEvents.forEach((evt) => {
  window.addEventListener(evt, showScreenHotspots, { passive: true });
});

globalEndEvents.forEach((evt) => {
  window.addEventListener(
    evt,
    () => {
      scheduleHotspotHide();
    },
    { passive: true }
  );
});

if (modelViewer) {
  modelViewer.addEventListener("pointerdown", showScreenHotspots);
  modelViewer.addEventListener("pointerup", () => scheduleHotspotHide());
  modelViewer.addEventListener("pointercancel", () => scheduleHotspotHide());
  modelViewer.addEventListener("interaction-start", showScreenHotspots);
  modelViewer.addEventListener("interaction-end", () => scheduleHotspotHide());
  modelViewer.addEventListener("select", () => bumpHotspotVisibility());

  modelViewer.addEventListener("load", () => {
    initializeModelState();
  });

  modelViewer.addEventListener("finished", () => {
    modelViewer.pause();
  });

  modelViewer.addEventListener("ar-status", (event) => {
    const status = event.detail.status;
    console.info(`[AR] ar-status 이벤트: ${status}`);

    // AR 세션 시작 또는 오브젝트 배치 시
    if (status === "session-started" || status === "object-placed") {
      // AR 모드 진입 시 자동 회전 즉시 중지
      console.info("[AR] AR 모드 진입 - 자동 회전 중지");
      arModeRequested = true;
      stopAutoRotation();
      showScreenHotspots();

      // AR 인디케이터(바운딩 박스) 숨기기 시도
      hideARIndicator();
    } else if (status === "not-presenting" || status === "failed") {
      // AR 세션 종료 시
      console.info("[AR] AR 모드 종료");
      arModeRequested = false;

      // 저장된 회전값 복원
      if (savedRotationBeforeAR !== null) {
        console.info(`[AR] 회전값 복원: ${savedRotationBeforeAR}도`);
        applyModelRotation(savedRotationBeforeAR);
        savedRotationBeforeAR = null;
      }

      bumpHotspotVisibility();
    }
  });

  /**
   * AR 인디케이터(바운딩 박스, 배치 원형 등)를 숨기는 함수
   * model-viewer 내부 Three.js scene을 탐색하여 관련 요소를 숨김
   */
  function hideARIndicator() {
    try {
      // model-viewer 내부 렌더러/scene 접근
      const scene = modelViewer[Object.getOwnPropertySymbols(modelViewer)
        .find(s => s.description === 'scene')] || modelViewer.model;

      if (!scene) {
        console.warn("[AR] scene을 찾을 수 없습니다.");
        return;
      }

      // scene 전체를 탐색하여 인디케이터 관련 요소 숨기기
      scene.traverse?.((node) => {
        const name = (node.name || '').toLowerCase();
        // 인디케이터 관련 이름 패턴: ring, circle, shadow, indicator, reticle, placement
        if (name.includes('ring') ||
            name.includes('circle') ||
            name.includes('indicator') ||
            name.includes('reticle') ||
            name.includes('placement') ||
            name.includes('footprint')) {
          console.info(`[AR] 인디케이터 숨김: ${node.name}`);
          node.visible = false;
        }
      });

      console.info("[AR] 인디케이터 숨김 시도 완료");
    } catch (error) {
      console.warn("[AR] 인디케이터 숨김 실패:", error);
    }
  }
}

/**
 * AR 버튼 클릭 시 자동 회전 즉시 중지 및 회전 초기화
 * - WebXR, Scene Viewer, Quick Look 모두에서 작동
 * - ar-status 이벤트보다 먼저 발생하므로 확실하게 회전 중지
 * - 회전값을 저장하고 초기화하여 AR 인디케이터 크기 문제 해결
 */
if (arButton) {
  arButton.addEventListener("click", () => {
    console.info("[AR] AR 버튼 클릭 - 자동 회전 중지 및 회전 초기화");
    arModeRequested = true;
    stopAutoRotation();
    clearTimeout(hotspotHideTimer);

    // 현재 회전값 저장 후 초기화 (AR 인디케이터 크기 문제 해결)
    savedRotationBeforeAR = rotationState.current;
    console.info(`[AR] 회전값 저장: ${savedRotationBeforeAR}도 → 0도로 초기화`);
    applyModelRotation(0);
  });
}

/**
 * Page Visibility API: Scene Viewer/Quick Look 앱 전환 감지
 * - 페이지가 hidden 상태가 되면 AR 앱으로 전환된 것으로 간주
 * - 페이지가 visible 상태로 돌아오면 AR 앱 종료로 간주
 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // 페이지가 숨겨짐 (Scene Viewer/Quick Look으로 전환되었을 수 있음)
    console.info("[Visibility] 페이지 hidden - 자동 회전 중지");
    stopAutoRotation();
    clearTimeout(hotspotHideTimer);
  } else {
    // 페이지가 다시 보임 (AR 앱에서 돌아옴)
    console.info("[Visibility] 페이지 visible - AR 모드 해제");
    arModeRequested = false;

    // 저장된 회전값 복원
    if (savedRotationBeforeAR !== null) {
      console.info(`[Visibility] 회전값 복원: ${savedRotationBeforeAR}도`);
      applyModelRotation(savedRotationBeforeAR);
      savedRotationBeforeAR = null;
    }

    bumpHotspotVisibility();
  }
});

/**
 * 애니메이션 토글: Chair ↔ Stretch 전환 (0.3초 크로스페이드)
 */
function toggleAnimation() {
  if (!modelViewer || !chairAnimationName || !stretchAnimationName) {
    console.warn("애니메이션 정보를 찾을 수 없습니다.");
    return;
  }

  bumpHotspotVisibility();
  const nextState = animationState === "chair" ? "stretch" : "chair";
  const nextAnimation = nextState === "chair" ? chairAnimationName : stretchAnimationName;

  modelViewer.animationCrossfadeDuration = 300;
  modelViewer.animationLoop = false;
  modelViewer.animationName = nextAnimation;
  modelViewer.play({ repetitions: 1 });

  animationState = nextState;
  updateAnimationUI();
}

animationToggleButton?.addEventListener("click", toggleAnimation);

/**
 * 컬러(디퓨즈 텍스처) 순환 버튼
 */
colorCycleButton?.addEventListener("click", async () => {
  if (!baseMaterial) {
    console.warn("기본 재질을 찾을 수 없어 텍스처를 교체할 수 없습니다.");
    return;
  }

  bumpHotspotVisibility();
  const previousIndex = currentTextureIndex;
  currentTextureIndex = (currentTextureIndex + 1) % TEXTURE_SEQUENCE.length;
  const textureInfo = TEXTURE_SEQUENCE[currentTextureIndex];

  try {
    await applyTextureInfo(textureInfo);
  } catch (error) {
    console.error("텍스처 적용 실패:", error);
    currentTextureIndex = previousIndex;
  }
});

/**
 * 회전 버튼: 현재 각도 기준으로 Z축 +90° 회전 (0.3초 이징)
 */
rotateButton?.addEventListener("click", () => {
  bumpHotspotVisibility();
  startRotationAnimation(rotationState.current, rotationState.current + 90);
});

/**
 * Z축 회전 애니메이션 (easeInOutCubic)
 */
function startRotationAnimation(fromDeg, toDeg) {
  stopAutoRotation();
  cancelRotationAnimation();

  rotationState.from = normalizeDegrees(fromDeg);
  rotationState.to = normalizeDegrees(toDeg);
  rotationState.startTime = null;

  const duration = 300;

  const step = (timestamp) => {
    if (rotationState.startTime === null) {
      rotationState.startTime = timestamp;
    }

    const elapsed = timestamp - rotationState.startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeInOutCubic(t);
    const current =
      rotationState.from + shortestAngleDelta(rotationState.from, rotationState.to) * eased;

    applyModelRotation(current);

    if (t < 1) {
      rotationState.raf = requestAnimationFrame(step);
    } else {
      rotationState.current = normalizeDegrees(rotationState.to);
      rotationState.raf = null;
    }
  };

  rotationState.raf = requestAnimationFrame(step);
}

function cancelRotationAnimation() {
  if (rotationState.raf !== null) {
    cancelAnimationFrame(rotationState.raf);
    rotationState.raf = null;
  }
}

function applyModelRotation(angleDeg) {
  if (!modelViewer) return;
  rotationState.current = normalizeDegrees(angleDeg);
  // Z축 회전 (이 모델에서는 Z축이 수평 회전)
  const newZ = baseOrientation.z + rotationState.current;
  const orientationString = formatOrientation({
    x: baseOrientation.x,
    y: baseOrientation.y,
    z: newZ,
  });
  modelViewer.orientation = orientationString;
  modelViewer.requestRender?.();
}

function normalizeDegrees(value) {
  const result = value % 360;
  return result < 0 ? result + 360 : result;
}

function shortestAngleDelta(fromDeg, toDeg) {
  let delta = normalizeDegrees(toDeg) - normalizeDegrees(fromDeg);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 자동 회전 시작: 느린 속도로 지속적으로 Z축 회전
 * AR 모드에서는 실행되지 않음
 */
function startAutoRotation() {
  // AR 모드에서는 자동 회전 비활성화 (실시간 체크)
  if (checkIsInAR()) {
    console.info("[AutoRotate] AR 모드에서는 자동 회전이 비활성화됩니다.");
    return;
  }
  if (autoRotateState.isActive || !modelViewer) return;

  autoRotateState.isActive = true;
  autoRotateState.lastTime = null;

  const autoRotateStep = (timestamp) => {
    // AR 모드 진입 시 루프 자동 중단 (실시간 체크)
    if (!autoRotateState.isActive || checkIsInAR()) {
      stopAutoRotation();
      return;
    }

    if (autoRotateState.lastTime === null) {
      autoRotateState.lastTime = timestamp;
    }

    const deltaTime = (timestamp - autoRotateState.lastTime) / 1000; // 초 단위
    autoRotateState.lastTime = timestamp;

    // 현재 각도에서 deltaTime만큼 회전
    const deltaAngle = autoRotateState.speed * deltaTime;
    applyModelRotation(rotationState.current + deltaAngle);

    autoRotateState.raf = requestAnimationFrame(autoRotateStep);
  };

  autoRotateState.raf = requestAnimationFrame(autoRotateStep);
}

/**
 * 자동 회전 중지
 */
function stopAutoRotation() {
  autoRotateState.isActive = false;
  if (autoRotateState.raf !== null) {
    cancelAnimationFrame(autoRotateState.raf);
    autoRotateState.raf = null;
  }
  autoRotateState.lastTime = null;
}

/**
 * 모델 로드 후 재질/텍스처 정보를 캐싱한다.
 */
function captureBaseMaterial() {
  if (!modelViewer) return;

  const materials = modelViewer.model?.materials;
  if (!materials || materials.length === 0) {
    console.warn("모델에서 재질을 찾을 수 없습니다.");
    return;
  }

  baseMaterial = materials[0];
  baseColorTextureSlot = baseMaterial.pbrMetallicRoughness?.baseColorTexture ?? null;
  originalBaseTexture = baseColorTextureSlot?.texture ?? null;
}

/**
 * 사용 가능한 애니메이션을 확인하고 초기 상태(Chair 모드)를 재생한다.
 */
function detectAnimations() {
  if (!modelViewer) return;

  const available = modelViewer.availableAnimations || [];
  if (available.length === 0) {
    console.warn("모델에 포함된 애니메이션이 없습니다.");
    return;
  }

  chairAnimationName = available.find((name) => name.toLowerCase().includes("chair")) ?? available[0];
  stretchAnimationName =
    available.find((name) => name.toLowerCase().includes("stretch")) ??
    available.find((name) => name !== chairAnimationName) ??
    available[0];

  modelViewer.animationName = chairAnimationName;
  modelViewer.animationLoop = false;
  modelViewer.animationCrossfadeDuration = 300;
  modelViewer.play({ repetitions: 1 });
  animationState = "chair";
}

/**
 * 애니메이션 버튼의 썸네일과 접근성 레이블을 업데이트한다.
 */
function updateAnimationUI() {
  if (!animationToggleButton || !animationThumb) return;
  const config = ANIMATION_STATE_MAP[animationState];
  if (!config) return;

  animationThumb.src = config.thumb;
  animationThumb.alt = `${config.label} 썸네일`;

  const nextStateLabel =
    animationState === "chair" ? ANIMATION_STATE_MAP.stretch.label : ANIMATION_STATE_MAP.chair.label;
  animationToggleButton.setAttribute("aria-label", `애니메이션 전환 - 다음: ${nextStateLabel}`);
}

/**
 * 텍스처 파일을 선로드해 전환 지연을 줄인다.
 */
function preloadVariantTextures() {
  TEXTURE_SEQUENCE.forEach((texture) => {
    if (!texture.uri) return;
    getTextureForUri(texture.uri).catch((error) => {
      console.warn("텍스처 선로드 실패:", error);
    });
  });
}

/**
 * baseColorTexture 슬롯에 새로운 텍스처를 적용한다.
 */
async function applyTextureInfo(textureInfo) {
  if (!modelViewer) return;
  if (!baseMaterial) {
    throw new Error("재질 정보가 준비되지 않았습니다.");
  }

  const slot = baseMaterial.pbrMetallicRoughness?.baseColorTexture ?? baseColorTextureSlot;
  if (!slot || typeof slot.setTexture !== "function") {
    console.warn("baseColorTexture 슬롯을 찾을 수 없습니다.");
    return;
  }

  if (!textureInfo || !textureInfo.uri) {
    if (originalBaseTexture) {
      slot.setTexture(originalBaseTexture);
      baseColorTextureSlot = slot;
      modelViewer.requestRender?.();
    } else {
      console.warn("복구할 기본 텍스처가 없습니다.");
    }
    return;
  }

  const gltfTexture = await getTextureForUri(textureInfo.uri);
  if (!gltfTexture) {
    throw new Error(`텍스처 로드 실패: ${textureInfo.uri}`);
  }

  slot.setTexture(gltfTexture);
  baseColorTextureSlot = slot;
  modelViewer.requestRender?.();
}

/**
 * model-viewer의 createTexture() API를 활용해 텍스처를 생성/캐싱한다.
 */
async function getTextureForUri(uri) {
  if (!modelViewer || !uri) return null;

  if (textureCache.has(uri)) {
    return textureCache.get(uri);
  }

  const texture = await modelViewer.createTexture(uri);
  textureCache.set(uri, texture);
  return texture;
}

preloadVariantTextures();

/**
 * 초기 모델 로딩 완료 시 재질/애니메이션/오리엔테이션 정보 캐싱 및 타이머 초기화.
 */
function initializeModelState() {
  if (!modelViewer || modelInitialized) return;
  if (!modelViewer.model) {
    // 모델이 아직 완전히 준비되지 않은 경우 다음 프레임에서 다시 시도
    requestAnimationFrame(initializeModelState);
    return;
  }

  modelInitialized = true;
  captureBaseOrientation();
  applyModelRotation(rotationState.current);
  captureBaseMaterial();
  detectAnimations();
  updateAnimationUI();
  showScreenHotspots();
  scheduleHotspotHide();
}

/**
 * orientation 속성을 파싱해 기본 회전값을 저장한다.
 * orientation="Xdeg Ydeg Zdeg" 형태를 가정한다.
 */
function captureBaseOrientation() {
  if (!modelViewer) return;
  const rawOrientation =
    modelViewer.getAttribute("orientation") ?? modelViewer.orientation ?? "0deg 0deg 0deg";
  baseOrientation = parseOrientation(rawOrientation);
}

function parseOrientation(value) {
  const defaults = { x: 0, y: 0, z: 0 };
  if (!value || typeof value !== "string") {
    return defaults;
  }

  const parts = value
    .trim()
    .split(/\s+/)
    .map((token) => parseFloat(token.replace("deg", "")));

  return {
    x: Number.isFinite(parts[0]) ? parts[0] : defaults.x,
    y: Number.isFinite(parts[1]) ? parts[1] : defaults.y,
    z: Number.isFinite(parts[2]) ? parts[2] : defaults.z,
  };
}

function formatOrientation({ x, y, z }) {
  const normalized = {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };

  return `${normalized.x}deg ${normalized.y}deg ${normalized.z}deg`;
}

// 모델이 이미 로드된 상태로 스크립트가 실행되는 경우를 대비해 즉시 초기화 시도
if (modelViewer?.model) {
  initializeModelState();
}
