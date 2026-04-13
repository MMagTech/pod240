/**
 * Orchestrates gate → TV batch by season → orphans → or per-file metadata.
 */

import type { CommonTagFields } from "./metadata-common";
import { promptMetadataOrSkip } from "./metadata-gate";
import type { AnalyzeResult, EnqueueTaggedItemPayload, TvBatchCarryForward } from "./metadata-modal";
import {
  promptSingleFileMetadata,
  promptTvSeasonGroupBatch,
  promptTvUnparsedOrphans,
} from "./metadata-modal";

function tvBatchCarryForwardFromItems(items: EnqueueTaggedItemPayload[]): TvBatchCarryForward {
  const t = items[0]!.tags;
  if (t.kind !== "tv") {
    throw new Error("tvBatchCarryForwardFromItems: expected TV tags");
  }
  const common: CommonTagFields = {};
  if (t.description) common.description = t.description;
  if (t.longDescription) common.longDescription = t.longDescription;
  if (t.genre) common.genre = t.genre;
  if (t.releaseDate) common.releaseDate = t.releaseDate;
  if (t.sortTitle) common.sortTitle = t.sortTitle;
  if (t.hdVideo) common.hdVideo = t.hdVideo;
  if (t.contentRating) common.contentRating = t.contentRating;
  if (t.encoder) common.encoder = t.encoder;
  if (t.copyright) common.copyright = t.copyright;
  return {
    show: t.showName,
    tvNetwork: t.tvNetwork,
    sortShow: t.sortShow,
    artworkBase64: t.artworkBase64,
    common: Object.keys(common).length > 0 ? common : undefined,
  };
}

export type MetadataWizardResult =
  | { outcome: "cancel" }
  | { outcome: "skip" }
  | { outcome: "tagged"; items: EnqueueTaggedItemPayload[] };

export async function runMetadataWizard(
  analysis: AnalyzeResult,
  appendLog: (s: string) => void
): Promise<MetadataWizardResult> {
  const gate = await promptMetadataOrSkip();
  if (gate === "cancel") return { outcome: "cancel" };
  if (gate === "skip") return { outcome: "skip" };

  const { files, suggestBatchTv, seasonGroups, unparsedFileIndices } = analysis;

  if (files.length === 0) {
    return { outcome: "skip" };
  }

  // Majority TV + multiple files: one batch dialog per detected season, then unparsed orphans.
  if (suggestBatchTv && files.length > 1) {
    const totalSeasonSteps = seasonGroups.length;
    const batchItems: EnqueueTaggedItemPayload[][] = [];
    const seasonIndexStack: number[] = [];
    let si = 0;
    let prefillSeason: EnqueueTaggedItemPayload[] | undefined;
    let prefillOrphans: EnqueueTaggedItemPayload[] | undefined;

    main: for (;;) {
      while (si < seasonGroups.length) {
        const group = seasonGroups[si]!;
        const subset = group.fileIndices.map((i) => files[i]!).filter(Boolean);
        if (subset.length === 0) {
          si++;
          continue;
        }

        const moreSeasonsAhead = si < seasonGroups.length - 1;
        const baseSeasonLine =
          totalSeasonSteps > 1
            ? `Season ${group.season} of ${totalSeasonSteps} (${subset.length} file(s)).`
            : "One season — shared show name and artwork. Episode numbers are per file.";

        const hintParts: string[] = [];
        if (si > 0) {
          hintParts.push(
            "Show, network, sort show, optional tags (including release date), and artwork are prefilled from the previous season — edit only if needed."
          );
        }
        hintParts.push(baseSeasonLine);
        if (moreSeasonsAhead) {
          hintParts.push("After you confirm, the next season step opens.");
        } else if (unparsedFileIndices.length > 0) {
          hintParts.push("After you confirm, unparsed filenames are listed next.");
        } else {
          hintParts.push("Last tagging step for this folder — then all jobs are added to the queue together.");
        }
        const stepHint = hintParts.join(" ");

        const confirmLabel = moreSeasonsAhead
          ? "Confirm & Next Season"
          : unparsedFileIndices.length > 0
            ? "Confirm & Continue"
            : "Add to Queue";

        const carryForward =
          si > 0 && batchItems.length > 0
            ? tvBatchCarryForwardFromItems(batchItems[batchItems.length - 1]!)
            : undefined;

        const batch = await promptTvSeasonGroupBatch(subset, group.season, appendLog, stepHint, {
          confirmButtonLabel: confirmLabel,
          carryForward,
          canGoBack: batchItems.length > 0,
          prefillItems: prefillSeason,
        });
        prefillSeason = undefined;

        if (batch.type === "cancel") return { outcome: "cancel" };
        if (batch.type === "back") {
          prefillSeason = batchItems.pop()!;
          const prev = seasonIndexStack.pop();
          si = prev ?? 0;
          continue;
        }
        batchItems.push(batch.items);
        seasonIndexStack.push(si);
        si++;
      }

      if (unparsedFileIndices.length === 0) {
        return { outcome: "tagged", items: batchItems.flat() };
      }

      const orphans = unparsedFileIndices.map((i) => files[i]!).filter(Boolean);
      const orphanCarry =
        batchItems.length > 0
          ? tvBatchCarryForwardFromItems(batchItems[batchItems.length - 1]!)
          : undefined;

      const orphanRes = await promptTvUnparsedOrphans(orphans, appendLog, {
        carryForward: orphanCarry,
        canGoBack: batchItems.length > 0,
        prefillItems: prefillOrphans,
      });
      prefillOrphans = undefined;

      if (orphanRes.type === "cancel") return { outcome: "cancel" };
      if (orphanRes.type === "back") {
        prefillSeason = batchItems.pop()!;
        const prev = seasonIndexStack.pop();
        si = prev ?? 0;
        continue main;
      }
      return {
        outcome: "tagged",
        items: [...batchItems.flat(), ...orphanRes.items],
      };
    }
  }

  // Single file, or non–TV-majority: one metadata dialog per file (movie / TV / music video).
  const n = files.length;
  const acc: EnqueueTaggedItemPayload[] = [];
  let i = 0;
  let prefill: EnqueueTaggedItemPayload | undefined;

  while (i < n) {
    const f = files[i]!;
    const one = await promptSingleFileMetadata(f, appendLog, {
      showSkipTagging: false,
      multiFile: n > 1 ? { fileIndex: i + 1, totalFiles: n } : undefined,
      canGoBack: i > 0,
      prefillItem: prefill,
    });
    prefill = undefined;
    if (one.type === "cancel") return { outcome: "cancel" };
    if (one.type === "back") {
      if (i <= 0) {
        prefill = undefined;
        continue;
      }
      prefill = acc.pop();
      i--;
      continue;
    }
    acc.push(one.item);
    i++;
  }
  return { outcome: "tagged", items: acc };
}
