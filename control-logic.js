(function () {
  const appGlobals = window.AppGlobals;
  const txData = appGlobals.txData;
  const controlLogicData = appGlobals.controlLogicData;
  const manualControlConfig = window.APP_CONFIG?.manualControl ?? {};
  const MANUAL_AXIS_DEADBAND = 0.05;
  const MANUAL_STEER_MAX = Math.max(0, Number(manualControlConfig.steerMax) || 300);
  const MANUAL_SPEED_MAX = Math.max(0, Number(manualControlConfig.speedMax) || 4000);
  const MANUAL_BRAKE_MAX = Math.max(0, Number(manualControlConfig.brakeMax) || 100);
  const AUTO_SPEED_MODE_TORQUE_REQUEST = 1950;
  const AUTO_TORQUE_MODE_SPEED_REQUEST = 4000;
  const AUTO_TORQUE_MODE_TORQUE_MAX = 1950;

  function setOutputs(missionStatus, steer, speed, torque, direction, estop, brake = 0) {
    appGlobals.MISSION_STATUS = missionStatus;
    appGlobals.STEER_REQUEST = steer;
    appGlobals.SPEED_REQUEST = speed;
    appGlobals.TORQUE_REQUEST = torque;
    appGlobals.DIRECTION_REQUEST = direction;
    appGlobals.ESTOP_REQUEST = estop;
    appGlobals.BRAKE_REQUEST = brake;
  }

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

  function getAutoSubMode() {
    return appGlobals.AUTO_SUB_MODE === "torque" ? "torque" : "speed";
  }

  function getAutoDefaultDriveOutputs(autoSubMode) {
    if (autoSubMode !== "torque") {
      return {
        speed: getManualSpeedRequest(),
        torque: AUTO_SPEED_MODE_TORQUE_REQUEST,
        brake: getManualBrakeRequest(),
      };
    }

    const normalizedY = normalizeAxisWithDeadband(appGlobals.GAMEPAD_Y_AXIS);
    if (normalizedY === 0) {
      return {
        speed: 0,
        torque: 0,
        brake: 0,
      };
    }

    return {
      speed: normalizedY < 0 ? AUTO_TORQUE_MODE_SPEED_REQUEST : 0,
      torque: Math.round(Math.abs(normalizedY) * AUTO_TORQUE_MODE_TORQUE_MAX),
      brake: 0,
    };
  }

  function evaluateAsState() {
    const autoSubMode = getAutoSubMode();

    txData.asState = appGlobals.AS_STATE;

    controlLogicData.activeCase = `AS_${appGlobals.AS_STATE}`;
    controlLogicData.statusText = "Unhandled AS_STATE";
    controlLogicData.autoSubMode = autoSubMode;
    controlLogicData.allowTorque = false;
    controlLogicData.readyToDrive = false;
    controlLogicData.finishRequested = false;
    controlLogicData.emergencyActive = false;
    controlLogicData.handshakeValid = appGlobals.HANDSHAKE;
    controlLogicData.goSignalActive = appGlobals.GO_SIGNAL;

    switch (appGlobals.AS_STATE) {
      case 0x0:
      case 0x1:
      case 0x2:
        controlLogicData.activeCase =
          appGlobals.AS_STATE === 0x0
            ? "AS_INIT"
            : appGlobals.AS_STATE === 0x1
              ? "AS_OFF"
              : "AS_READY";
        controlLogicData.statusText = appGlobals.AMI_STATE !== 0
          ? "AMI active, mission status set"
          : "AMI idle";
        appGlobals.MISSION_STATUS = appGlobals.AMI_STATE !== 0 ? 1 : 0;
        appGlobals.STEER_REQUEST = 0;
        appGlobals.TORQUE_REQUEST = 0;
        appGlobals.SPEED_REQUEST = 0;
        appGlobals.BRAKE_REQUEST = 0;
        appGlobals.DIRECTION_REQUEST = 0;
        appGlobals.ESTOP_REQUEST = 0;
        appGlobals.mission_timer = 0;
        controlLogicData.readyToDrive = appGlobals.AS_STATE === 0x2;
        break;

      case 0x3:
        controlLogicData.activeCase = "AS_DRIVING";

        switch (appGlobals.AMI_STATE) {
          default: {
            const autoDriveOutputs = getAutoDefaultDriveOutputs(autoSubMode);
            controlLogicData.activeCase = "AS_DRIVING_DEFAULT";
            controlLogicData.statusText = appGlobals.GAMEPAD_BUTTON_0_PRESSED
              ? `Auto ${autoSubMode}: mission stop request`
              : `Auto ${autoSubMode}: driving request`;
            setOutputs(
              appGlobals.GAMEPAD_BUTTON_0_PRESSED ? 3 : 1,
              getManualSteerRequest(),
              autoDriveOutputs.speed,
              autoDriveOutputs.torque,
              1,
              0,
              autoDriveOutputs.brake
            );
            break;
          }

          case 0x5:
            controlLogicData.activeCase = "AS_DRIVING_STATIC_A";

            if (appGlobals.mission_timer < 1000) {
              controlLogicData.statusText = "Static A: settle";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 2000) {
              controlLogicData.statusText = "Static A: steer right";
              setOutputs(1, 250, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 4000) {
              controlLogicData.statusText = "Static A: steer left";
              setOutputs(1, -250, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 5000) {
              controlLogicData.statusText = "Static A: center";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 7000) {
              controlLogicData.statusText = "Static A: drive";
              setOutputs(1, 0, 700, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 9000) {
              controlLogicData.statusText = "Static A: settle";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else {
              controlLogicData.statusText = "Static A: complete";
              setOutputs(3, 0, 0, 0, 0, 0);
            }
            break;

          case 0x6:
            controlLogicData.activeCase = "AS_DRIVING_STATIC_B";

            if (appGlobals.mission_timer < 1000) {
              controlLogicData.statusText = "Static B: settle";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 3000) {
              controlLogicData.statusText = "Static B: drive";
              setOutputs(1, 0, 700, 1950, 1, 0);
            } else {
              controlLogicData.statusText = "Static B: estop";
              setOutputs(1, 0, 0, 0, 0, 1);
            }
            break;

          case 0x7:
            controlLogicData.activeCase = "AS_DRIVING_DYNAMIC";

            if (appGlobals.mission_timer < 1000) {
              controlLogicData.statusText = "Dynamic: settle";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 2000) {
              controlLogicData.statusText = "Dynamic: steer right";
              setOutputs(1, 250, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 4000) {
              controlLogicData.statusText = "Dynamic: steer left";
              setOutputs(1, -250, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 5000) {
              controlLogicData.statusText = "Dynamic: center";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 7000) {
              controlLogicData.statusText = "Dynamic: drive phase 1";
              setOutputs(1, 0, 700, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 9000) {
              controlLogicData.statusText = "Dynamic: settle";
              setOutputs(1, 0, 0, 1950, 1, 0);
            } else if (appGlobals.mission_timer < 11000) {
              controlLogicData.statusText = "Dynamic: drive phase 2";
              setOutputs(1, 0, 700, 1950, 1, 0);
            } else {
              controlLogicData.statusText = "Dynamic: estop";
              setOutputs(1, 0, 0, 0, 0, 1);
            }
            break;
        }

        controlLogicData.readyToDrive = true;
        controlLogicData.allowTorque = appGlobals.TORQUE_REQUEST > 0 && appGlobals.ESTOP_REQUEST === 0;
        controlLogicData.finishRequested = appGlobals.MISSION_STATUS === 3;
        controlLogicData.emergencyActive = appGlobals.ESTOP_REQUEST !== 0;
        break;

      default:
        controlLogicData.activeCase = `AS_UNKNOWN_${appGlobals.AS_STATE}`;
        controlLogicData.statusText = "Unknown AS_STATE";
        appGlobals.MISSION_STATUS = 0;
        appGlobals.STEER_REQUEST = 0;
        appGlobals.TORQUE_REQUEST = 0;
        appGlobals.SPEED_REQUEST = 0;
        appGlobals.BRAKE_REQUEST = 0;
        appGlobals.DIRECTION_REQUEST = 0;
        appGlobals.ESTOP_REQUEST = 0;
        appGlobals.mission_timer = 0;
        break;
    }

    return {
      asState: appGlobals.AS_STATE,
      amiState: appGlobals.AMI_STATE,
      handshake: appGlobals.HANDSHAKE,
      goSignal: appGlobals.GO_SIGNAL,
      autoSubMode,
      missionStatus: appGlobals.MISSION_STATUS,
      missionTimer: appGlobals.mission_timer,
      activeCase: controlLogicData.activeCase,
      statusText: controlLogicData.statusText,
      label: `${controlLogicData.activeCase} (${appGlobals.AS_STATE})`,
    };
  }

  function create(options = {}) {
    const onLogicChanged =
      typeof options.onLogicChanged === "function" ? options.onLogicChanged : () => {};

    function refresh() {
      const snapshot = evaluateAsState();
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
      refresh,
      initial,
    };
  }

  window.ControlLogic = {
    create,
    evaluateAsState,
  };
})();
