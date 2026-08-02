import type { CSSProperties } from "react";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";
import { useConfigStore } from "@/stores/use-config-store";

type AboutButtonProps = { className?: string; style?: CSSProperties };

export function AboutButton({ className, style }: AboutButtonProps) {
    const { hasNewVersion } = useVersionCheck();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <button
            type="button"
            className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
            style={style}
            onClick={() => openConfigDialog(false, "about")}
            title="查看关于与版本更新"
        >
            <span className="relative inline-flex">
                {APP_VERSION}
                {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
            </span>
        </button>
    );
}
