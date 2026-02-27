(function () {
  const stateMachineData = window.AppGlobals.stateMachineData;
  const receivedData = window.AppGlobals.receivedData;

  const DEFAULT_STATE_ENUM = {
    AS_INIT: 0,
    AS_OFF: 1,
    AS_READY: 2,
    AS_DRIVING: 3,
    AS_FINISHED: 4,
    AS_EMERGENCY: 5,
  };

  const DEFAULT_STATE_SEQUENCE = [
    "AS_INIT",
    "AS_OFF",
    "AS_READY",
    "AS_DRIVING",
    "AS_FINISHED",
    "AS_EMERGENCY",
  ];

  const DEFAULT_STATE_MACHINE_INTERVAL_MS = 20;
  const DEFAULT_TRANSITION_BUTTON_INDEX = 0;

  function normalizeStateEnum(rawStates) {
    const next = { ...DEFAULT_STATE_ENUM };
    if (!rawStates || typeof rawStates !== "object") return next;

    for (const stateName of Object.keys(DEFAULT_STATE_ENUM)) {
      const rawValue = rawStates[stateName];
      if (!Number.isInteger(rawValue)) continue;
      if (rawValue < 0 || rawValue > 255) continue;
      next[stateName] = rawValue;
    }

    return next;
  }

  function normalizeStateSequence(rawSequence, stateEnum) {
    if (!Array.isArray(rawSequence) || !rawSequence.length) {
      return DEFAULT_STATE_SEQUENCE.slice();
    }

    const filtered = rawSequence.filter(
      (stateName) =>
        typeof stateName === "string" &&
        Object.prototype.hasOwnProperty.call(stateEnum, stateName)
    );

    return filtered.length ? filtered : DEFAULT_STATE_SEQUENCE.slice();
  }

  function loadStateMachineConfig(rawConfig) {
    const states = normalizeStateEnum(rawConfig?.states);
    const sequence = normalizeStateSequence(rawConfig?.sequence, states);

    const intervalMs = Number(rawConfig?.intervalMs);
    const transitionButtonIndex = Number(rawConfig?.transitionButtonIndex);

    return {
      intervalMs:
        Number.isFinite(intervalMs) && intervalMs > 0
          ? Math.max(1, Math.round(intervalMs))
          : DEFAULT_STATE_MACHINE_INTERVAL_MS,
      transitionButtonIndex:
        Number.isInteger(transitionButtonIndex) && transitionButtonIndex >= 0
          ? transitionButtonIndex
          : DEFAULT_TRANSITION_BUTTON_INDEX,
      states,
      sequence,
    };
  }

  function describeStateMachineConfig(config) {
    const enumSummary = config.sequence
      .map((stateName) => `${stateName}=${config.states[stateName]}`)
      .join(", ");

    return `${config.intervalMs}ms, btn#${config.transitionButtonIndex}, ${enumSummary}`;
  }

  function createAsyncLoop(intervalMs, task) {
    let active = false;
    let timeoutHandle = 0;

    async function run() {
      if (!active) return;

      const startedAt = performance.now();
      try {
        await task();
      } catch (e) {
        console.error(e);
      }

      if (!active) return;

      const elapsed = performance.now() - startedAt;
      const nextDelay = Math.max(0, intervalMs - elapsed);
      timeoutHandle = window.setTimeout(run, nextDelay);
    }

    return {
      start() {
        if (active) return;
        active = true;
        timeoutHandle = window.setTimeout(run, intervalMs);
      },

      stop() {
        active = false;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = 0;
        }
      },
    };
  }

  function create(options = {}) {
    const config = loadStateMachineConfig(options.config);
    const getPrimaryGamepad =
      typeof options.getPrimaryGamepad === "function" ? options.getPrimaryGamepad : () => null;
    const onConfigLoaded =
      typeof options.onConfigLoaded === "function" ? options.onConfigLoaded : () => {};
    const onStateChanged =
      typeof options.onStateChanged === "function" ? options.onStateChanged : () => {};

    let currentStateName = config.sequence[0];
    let transitionButtonWasPressed = false;
    let remoteAdvanceWasRequested = false;
    let loop = null;

    function getCurrentStateValue() {
      return config.states[currentStateName] ?? DEFAULT_STATE_ENUM.AS_INIT;
    }

    function notifyStateChanged() {
      const stateValue = getCurrentStateValue();
      stateMachineData.stateName = currentStateName;
      stateMachineData.stateValue = stateValue;

      onStateChanged({
        name: currentStateName,
        value: stateValue,
        label: `${currentStateName} (${stateValue})`,
      });
    }

    function advance() {
      const currentIndex = config.sequence.indexOf(currentStateName);
      const nextIndex =
        currentIndex >= 0
          ? (currentIndex + 1) % config.sequence.length
          : 0;

      currentStateName = config.sequence[nextIndex];
      notifyStateChanged();
    }

    async function tick() {
      const gamepad = getPrimaryGamepad();
      const isPressed = !!gamepad?.buttons?.[config.transitionButtonIndex]?.pressed;
      const remoteAdvanceRequested = !!receivedData.exampleRemoteAdvanceRequest;

      if (isPressed && !transitionButtonWasPressed) {
        advance();
      }

      if (remoteAdvanceRequested && !remoteAdvanceWasRequested) {
        advance();
      }

      transitionButtonWasPressed = isPressed;
      remoteAdvanceWasRequested = remoteAdvanceRequested;
    }

    function start() {
      stop();
      loop = createAsyncLoop(config.intervalMs, tick);
      loop.start();
    }

    function stop() {
      if (!loop) return;
      loop.stop();
      loop = null;
    }

    onConfigLoaded({
      config,
      description: describeStateMachineConfig(config),
    });
    notifyStateChanged();

    return {
      start,
      stop,
      tick,
      advance,
      getConfig() {
        return config;
      },
      getCurrentStateName() {
        return currentStateName;
      },
      getCurrentStateValue,
    };
  }

  window.AppStateMachine = {
    create,
  };
})();
