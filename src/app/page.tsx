import { AuthGate } from "@/components/auth/AuthGate";
import { ZestawienieView } from "@/components/zestawienie/ZestawienieView";

export default function Home() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50 dark:bg-black">
      <AuthGate>
        <ZestawienieView />
      </AuthGate>
    </div>
  );
}
