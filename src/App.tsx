import { EditorProvider } from "./context/EditorContext";
import { Workspace } from "./components/Workspace";

export default function App() {
  return <EditorProvider><Workspace /></EditorProvider>;
}
