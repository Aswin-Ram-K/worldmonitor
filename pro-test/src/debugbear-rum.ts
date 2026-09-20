/**
 * The marketing bundle ships the same DebugBear bootstrap as the dashboard.
 * Keep one implementation so queue bounds, primitive snapshots, and listener
 * teardown cannot drift between the two production surfaces.
 */
export {
  DEBUGBEAR_RUM_HOSTS,
  DEBUGBEAR_RUM_SAMPLE_RATE,
  DEBUGBEAR_RUM_SCRIPT_SRC,
  initDebugBearRum,
  resetDebugBearRumForTesting,
  shouldEnableDebugBearRum,
} from '../../src/bootstrap/debugbear-rum';
