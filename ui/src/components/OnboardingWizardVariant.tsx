import { useBoardSession } from "../hooks/useBoardSession";
import { OnboardingWizard } from "./OnboardingWizard";

/**
 * Default onboarding wizard. Conference-room chat is now the only surface left
 * behind `enableConferenceRoomChat`; onboarding stays available without that
 * experimental flag.
 */
export function OnboardingWizardVariant() {
  const hasBoardSession = useBoardSession();
  return hasBoardSession ? <OnboardingWizard /> : null;
}
