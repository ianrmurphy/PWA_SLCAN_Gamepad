(function () {
  const appGlobals = window.AppGlobals;
  const txData = appGlobals.txData;
  const controlLogicData = appGlobals.controlLogicData;
  const manualControlConfig = window.APP_CONFIG?.manualControl ?? {};
  const MANUAL_AXIS_DEADBAND = 0.05;
  const MANUAL_STEER_MAX = Math.max(0, Number(manualControlConfig.steerMax) || 300);
  const MANUAL_SPEED_MAX = Math.max(0, Number(manualControlConfig.speedMax) || 4000);
  const MANUAL_BRAKE_MAX = Math.max(0, Number(manualControlConfig.brakeMax) || 100);
  const fallbackPreviousPressCounts = {
    button0: 0,
    button1: 0,
    button2: 0,
    button3: 0,
  };

  function normalizeAxisWithDeadband(value, deadband = MANUAL_AXIS_DEADBAND) {
    const axisValue = Math.max(-1, Math.min(1, Number(value) || 0));
    const magnitude = Math.abs(axisValue);
    if (magnitude <= deadband) return 0;

    const normalizedMagnitude = (magnitude - deadband) / (1 - deadband);
    return Math.sign(axisValue) * Math.min(1, normalizedMagnitude);
  }

  function getNormalizedSteerAxis() {
    const primarySteer = normalizeAxisWithDeadband(appGlobals.GAMEPAD_X_AXIS);
    const secondarySteer = normalizeAxisWithDeadband(appGlobals.GAMEPAD_X2_AXIS);
    return Math.abs(primarySteer) >= Math.abs(secondarySteer) ? primarySteer : secondarySteer;
  }

  function getManualSteerRequest() {
    const normalizedSteer = getNormalizedSteerAxis();
    return Math.round(-normalizedSteer * MANUAL_STEER_MAX);
  }

  function getManualSpeedRequest() {
    const normalizedThrottle = normalizeAxisWithDeadband(-appGlobals.GAMEPAD_Y_AXIS);
    if (normalizedThrottle <= 0) return 0;
    return Math.round(normalizedThrottle * MANUAL_SPEED_MAX);
  }

  function getManualBrakeRequest() {
    const normalizedBrake = normalizeAxisWithDeadband(appGlobals.GAMEPAD_Y_AXIS);
    if (normalizedBrake <= 0) return 0;
    return Math.round(normalizedBrake * MANUAL_BRAKE_MAX);
  }

  function getNextMissionStatus(currentValue) {
    const currentStatus = Math.max(0, Math.min(3, Number(currentValue) || 0));
    return currentStatus >= 3 ? 0 : currentStatus + 1;
  }

  function toggleZeroOne(currentValue) {
    return Number(currentValue) === 1 ? 0 : 1;
  }

  function toggleTorqueRequest(currentValue) {
    return Number(currentValue) === 1950 ? 0 : 1950;
  }

  function applyPressDelta(previousCount, currentCount, action) {
    let safePreviousCount = Math.max(0, Number(previousCount) || 0);
    const safeCurrentCount = Math.max(0, Number(currentCount) || 0);
    while (safePreviousCount < safeCurrentCount) {
      action();
      safePreviousCount += 1;
    }
    return safeCurrentCount;
  }

  function evaluateRawControl(previousPressCounts = fallbackPreviousPressCounts) {
    const steerRequest = getManualSteerRequest();
    const speedRequest = getManualSpeedRequest();
    const brakeRequest = getManualBrakeRequest();

    txData.asState = appGlobals.AS_STATE;

    previousPressCounts.button0 = applyPressDelta(
      previousPressCounts.button0,
      appGlobals.GAMEPAD_BUTTON_0_PRESS_COUNT,
      () => {
        appGlobals.MISSION_STATUS = getNextMissionStatus(appGlobals.MISSION_STATUS);
      }
    );
    previousPressCounts.button1 = applyPressDelta(
      previousPressCounts.button1,
      appGlobals.GAMEPAD_BUTTON_1_PRESS_COUNT,
      () => {
        appGlobals.DIRECTION_REQUEST = toggleZeroOne(appGlobals.DIRECTION_REQUEST);
      }
    );
    previousPressCounts.button2 = applyPressDelta(
      previousPressCounts.button2,
      appGlobals.GAMEPAD_BUTTON_2_PRESS_COUNT,
      () => {
        appGlobals.ESTOP_REQUEST = toggleZeroOne(appGlobals.ESTOP_REQUEST);
      }
    );
    previousPressCounts.button3 = applyPressDelta(
      previousPressCounts.button3,
      appGlobals.GAMEPAD_BUTTON_3_PRESS_COUNT,
      () => {
        appGlobals.TORQUE_REQUEST = toggleTorqueRequest(appGlobals.TORQUE_REQUEST);
      }
    );

    if (appGlobals.MISSION_STATUS < 0 || appGlobals.MISSION_STATUS > 3) {
      appGlobals.MISSION_STATUS = Math.max(0, Math.min(3, Number(appGlobals.MISSION_STATUS) || 0));
    }

    appGlobals.STEER_REQUEST = steerRequest;
    appGlobals.SPEED_REQUEST = speedRequest;
    appGlobals.BRAKE_REQUEST = brakeRequest;
    appGlobals.mission_timer = 0;

    controlLogicData.activeCase = "RAW_MANUAL";
    controlLogicData.statusText = "Raw manual latched control";
    controlLogicData.allowTorque = appGlobals.TORQUE_REQUEST > 0 && appGlobals.ESTOP_REQUEST === 0;
    controlLogicData.readyToDrive = appGlobals.MISSION_STATUS !== 0;
    controlLogicData.finishRequested = appGlobals.MISSION_STATUS === 3;
    controlLogicData.emergencyActive = appGlobals.ESTOP_REQUEST !== 0;
    controlLogicData.handshakeValid = appGlobals.HANDSHAKE;
    controlLogicData.goSignalActive = appGlobals.GO_SIGNAL;

    return {
      asState: appGlobals.AS_STATE,
      amiState: appGlobals.AMI_STATE,
      handshake: appGlobals.HANDSHAKE,
      goSignal: appGlobals.GO_SIGNAL,
      missionStatus: appGlobals.MISSION_STATUS,
      missionTimer: appGlobals.mission_timer,
      activeCase: controlLogicData.activeCase,
      statusText: controlLogicData.statusText,
      label: "RAW_MANUAL",
    };
  }

  function create(options = {}) {
    const onLogicChanged =
      typeof options.onLogicChanged === "function" ? options.onLogicChanged : () => {};
    const previousPressCounts = {
      button0: Math.max(0, Number(appGlobals.GAMEPAD_BUTTON_0_PRESS_COUNT) || 0),
      button1: Math.max(0, Number(appGlobals.GAMEPAD_BUTTON_1_PRESS_COUNT) || 0),
      button2: Math.max(0, Number(appGlobals.GAMEPAD_BUTTON_2_PRESS_COUNT) || 0),
      button3: Math.max(0, Number(appGlobals.GAMEPAD_BUTTON_3_PRESS_COUNT) || 0),
    };

    function refresh() {
      const snapshot = evaluateRawControl(previousPressCounts);
      onLogicChanged(snapshot);
      return snapshot;
    }

    const initial = refresh();

    return {
      getCurrentAsState() {
        return appGlobals.AS_STATE;
      },
      getCurrentCase() {
        return controlLogicData.activeCase;
      },
      shouldTickMissionTimer() {
        return false;
      },
      refresh,
      initial,
    };
  }

  window.ControlRawLogic = {
    create,
    evaluateRawControl,
  };
})();
