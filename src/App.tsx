import { EditorProvider } from "./context/EditorProvider";
import { Workspace } from "./components/Workspace";

export default function App() {
  return <EditorProvider><Workspace /></EditorProvider>;
}
