import { AuthGate } from "@/components/auth/AuthGate";
import { ZestawienieView } from "@/components/zestawienie/ZestawienieView";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <AuthGate>
        <ZestawienieView />
      </AuthGate>
    </div>
  );
}
