import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import PairView from "./PairView";

type FakeDevice = { id: string; name: string; lastSeen: string };

async function fetchFakeDevices(): Promise<FakeDevice[]> {
	await new Promise((r) => setTimeout(r, 200));
	return [
		{ id: "a", name: "iPhone 15 Pro", lastSeen: "just now" },
		{ id: "b", name: "iPad", lastSeen: "2h ago" },
	];
}

export default function App() {
	if (typeof window !== "undefined" && window.location.hash === "#pair") {
		return <PairView />;
	}
	return <PopoverContent />;
}

function PopoverContent() {
	const [autoLaunch, setAutoLaunch] = useState(true);

	const devices = useQuery({
		queryKey: ["devices"],
		queryFn: fetchFakeDevices,
	});

	return (
		<div className="flex h-full w-full flex-col gap-3 p-4">
			<header className="flex items-center justify-between">
				<div className="font-medium">sidecode spike</div>
				<div className="text-xs text-zinc-500">react 19 + base-ui</div>
			</header>

			<section className="flex flex-col gap-1">
				<div className="text-xs text-zinc-400">Devices</div>
				{devices.isLoading ? (
					<div className="text-xs text-zinc-500">loading...</div>
				) : (
					(devices.data ?? []).map((d) => (
						<div
							key={d.id}
							className="flex items-center justify-between rounded px-2 py-1.5 text-sm"
						>
							<span>● {d.name}</span>
							<span className="text-xs text-zinc-500">{d.lastSeen}</span>
						</div>
					))
				)}
			</section>

			<section className="flex items-center justify-between rounded px-2 py-1.5 text-sm">
				<span>Launch at login</span>
				<Switch checked={autoLaunch} onCheckedChange={setAutoLaunch} />
			</section>

			<Button
				onClick={() => void window.electronAPI.openPairWindow()}
			>
				Pair new device
			</Button>

			<footer className="mt-auto text-xs text-zinc-500">
				query status: {devices.status}
			</footer>
		</div>
	);
}
