import { Button } from "@/components/ui/button";

export default function PairView() {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
			<div className="text-base font-semibold">Pair iPhone</div>
			<div className="flex h-48 w-48 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
				QR code placeholder
			</div>
			<div className="text-xs text-muted-foreground">Expires in 60s</div>
			<Button variant="secondary" size="sm" onClick={() => window.close()}>
				Cancel
			</Button>
		</div>
	);
}
