import { type PropsWithChildren, useEffect, useState } from "react";
import { EditorStore, EditorStoreContext } from "./EditorContext";

export function EditorProvider({ children }: PropsWithChildren) {
  const [store] = useState(() => new EditorStore());

  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);

  return <EditorStoreContext.Provider value={store}>{children}</EditorStoreContext.Provider>;
}
