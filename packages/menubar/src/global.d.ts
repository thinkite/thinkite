export {};

declare global {
	interface Window {
		electronAPI: {
			openPairWindow: () => Promise<void>;
		};
	}
}
