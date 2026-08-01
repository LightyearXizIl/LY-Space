export type ReleaseInfo = {
    version: string;
    date: string;
    items: { type: string; content: string }[];
};

export function normalizeReleaseVersion(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
    return match ? `v${match.slice(1).join(".")}` : "";
}

export function sortReleases(releases: ReleaseInfo[]) {
    return releases
        .filter((release) => normalizeReleaseVersion(release.version))
        .map((release) => ({ ...release, version: normalizeReleaseVersion(release.version) }))
        .sort((left, right) => {
            const a = normalizeReleaseVersion(left.version).slice(1).split(".").map(Number);
            const b = normalizeReleaseVersion(right.version).slice(1).split(".").map(Number);
            return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
        });
}

export function parseChangelog(content: string): ReleaseInfo[] {
    return content
        .split(/^## /m)
        .slice(1)
        .map((block) => {
            const [title = "", ...lines] = block.trim().split("\n");
            const [, version = title.trim(), date = ""] = title.match(/^(.+?)(?:\s+-\s+(.+))?$/) || [];
            return {
                version: normalizeReleaseVersion(version) || version.trim(),
                date: date.trim(),
                items: lines
                    .map((line) => line.trim().match(/^\+\s+\[(.+?)\]\s+(.+)$/))
                    .filter((match): match is RegExpMatchArray => Boolean(match))
                    .map((match) => ({ type: match[1], content: match[2] })),
            };
        })
        .filter((release) => release.items.length && release.version !== "Unreleased");
}
