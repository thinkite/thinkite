import PairView from "./PairView";

// V0 renderer entry: the menubar tray is a native NSMenu, so the renderer only
// hosts the Pair window. The pair window is loaded with `#pair` hash, but we
// don't gate on it — there is only one view.
export default function App() {
  return <PairView />;
}
