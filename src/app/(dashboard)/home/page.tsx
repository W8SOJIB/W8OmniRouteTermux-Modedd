import { getMachineId } from "@/shared/utils/machine";
import { getSettings } from "@/lib/localDb";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";
import KimiSponsorBanner from "../dashboard/KimiSponsorBanner";
import CheaperInferenceSponsorBanner from "../dashboard/CheaperInferenceSponsorBanner";
import VscodeCopilotBanner from "../dashboard/VscodeCopilotBanner";
import NewsBanner from "../dashboard/NewsBanner";
import FirstRunReadinessCard from "../dashboard/FirstRunReadinessCard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const settings = await getSettings();
  const machineId = await getMachineId();
  const isBootstrapped = process.env.OMNIROUTE_BOOTSTRAPPED === "true";
  return (
    <>
      {isBootstrapped && <BootstrapBanner />}
      <FirstRunReadinessCard setupComplete={Boolean(settings.setupComplete)} />
      <KimiSponsorBanner />
      <CheaperInferenceSponsorBanner />
      <VscodeCopilotBanner />
      <NewsBanner />
      <HomePageClient machineId={machineId} />
    </>
  );
}
