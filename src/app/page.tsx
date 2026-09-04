import { AuthGate } from "@/components/auth/AuthGate";
import { AppViews } from "@/components/AppViews";

export default function Home() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50 dark:bg-black">
      <AuthGate>
        <AppViews />
      </AuthGate>
    </div>
  );
}
