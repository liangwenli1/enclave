import { useCallback, useEffect, useState } from "react";
import { listFolders, type Folder } from "@/lib/kernel/host-api";

/* 文件夹。授权就是按它算的：文件夹开给谁，里面的环境他就看得到，
   之后新建进去的也自动跟着。规则在服务器那边，这里只是读一份来显示。

   不进本地存储：它是团队的东西，不是这台电脑的偏好，读不到就如实显示读不到。 */

export const DEFAULT_FOLDER = "default";

export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const reload = useCallback(async () => setFolders(await listFolders()), []);

  useEffect(() => {
    let alive = true;
    void listFolders().then((list) => alive && setFolders(list));
    return () => {
      alive = false;
    };
  }, []);

  return { folders, reload };
}

/** 显示用的名字。读不到文件夹清单时退回编号，总比什么都不显示强。 */
export function folderName(folders: Folder[], id: string): string {
  return folders.find((f) => f.id === id)?.name ?? id;
}
