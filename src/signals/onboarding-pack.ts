import { isFocusManifestPublicSafe } from "./focus-manifest";
import { nowIso } from "../utils/json";

export type RepoPolicyContributionLane = {
  id?: string | null;
  title: string;
  summary: string;
  preferredPaths?: string[];
  discouragedPaths?: string[];
  validationExpectations?: string[];
  publicNotes?: string[];
};

export type RepoPolicyLabelPolicy = {
  preferredLabels?: string[];
  requiredLabels?: string[];
  discouragedLabels?: string[];
  note?: string | null;
};

export type RepoPolicyCompilerOutput = {
  repoFullName: string;
  generatedAt?: string | null;
  contributionLanes?: RepoPolicyContributionLane[];
  labelPolicy?: RepoPolicyLabelPolicy;
  validationExpectations?: string[];
  readinessWarnings?: string[];
  maintainerExpectations?: string[];
  publicOutputBoundaries?: string[];
  privateOwnerContext?: string[];
};

export type RepoOnboardingDroppedPublicItem = {
  field: string;
  reason: "empty" | "unsafe_public_text";
};

export type RepoOnboardingContributionLane = {
  id: string;
  title: string;
  summary: string;
  preferredPaths: string[];
  discouragedPaths: string[];
  validationExpectations: string[];
  publicNotes: string[];
};

export type RepoOnboardingLabelPolicy = {
  preferredLabels: string[];
  requiredLabels: string[];
  discouragedLabels: string[];
  note: string | null;
};

export type RepoOnboardingPackPreview = {
  repoFullName: string;
  generatedAt: string;
  source: "policy_compiler";
  previewOnly: true;
  publicSafe: true;
  contributionLanes: RepoOnboardingContributionLane[];
  labelPolicy: RepoOnboardingLabelPolicy;
  validationExpectations: string[];
  readinessWarnings: string[];
  maintainerExpectations: string[];
  publicOutputBoundaries: string[];
  previewMarkdown: string;
  droppedPublicItems: RepoOnboardingDroppedPublicItem[];
  privateOwnerContext: {
    itemCount: number;
    includedInPublicPreview: false;
  };
  publication: {
    status: "preview_only";
    allowed: false;
    actions: string[];
    reason: string;
  };
};

const DEFAULT_PUBLIC_OUTPUT_BOUNDARIES = [
  "Keep sensitive credentials, account secrets, compensation estimates, private maintainer evidence, and local paths out of public contribution text.",
  "Keep the pack as guidance for accepted work, not as automated GitHub action.",
];

const DEFAULT_VALIDATION_EXPECTATIONS = [
  "Run the repository test command documented by maintainers before submitting.",
];

const DEFAULT_MAINTAINER_EXPECTATIONS = [
  "Keep pull requests small, reviewable, and tied to accepted repository scope.",
];

export function buildRepoOnboardingPackPreview(
  policyOutput: RepoPolicyCompilerOutput,
  options: { generatedAt?: string } = {},
): RepoOnboardingPackPreview {
  const droppedPublicItems: RepoOnboardingDroppedPublicItem[] = [];
  const generatedAt = options.generatedAt ?? policyOutput.generatedAt ?? nowIso();

  const contributionLanes = (policyOutput.contributionLanes ?? [])
    .map((lane, index) => sanitizeContributionLane(lane, index, droppedPublicItems))
    .filter((lane): lane is RepoOnboardingContributionLane => lane !== null);

  const labelPolicy = sanitizeLabelPolicy(policyOutput.labelPolicy, droppedPublicItems);
  const validationExpectations = safePublicList(
    policyOutput.validationExpectations,
    "validationExpectations",
    droppedPublicItems,
  );
  const readinessWarnings = safePublicList(
    policyOutput.readinessWarnings,
    "readinessWarnings",
    droppedPublicItems,
  );
  const maintainerExpectations = withDefaultPublicList(
    policyOutput.maintainerExpectations,
    DEFAULT_MAINTAINER_EXPECTATIONS,
    "maintainerExpectations",
    droppedPublicItems,
  );
  const publicOutputBoundaries = withDefaultPublicList(
    policyOutput.publicOutputBoundaries,
    DEFAULT_PUBLIC_OUTPUT_BOUNDARIES,
    "publicOutputBoundaries",
    droppedPublicItems,
  );
  const publicValidationExpectations =
    validationExpectations.length > 0
      ? validationExpectations
      : DEFAULT_VALIDATION_EXPECTATIONS;

  const preview: RepoOnboardingPackPreview = {
    repoFullName: policyOutput.repoFullName,
    generatedAt,
    source: "policy_compiler",
    previewOnly: true,
    publicSafe: true,
    contributionLanes,
    labelPolicy,
    validationExpectations: publicValidationExpectations,
    readinessWarnings,
    maintainerExpectations,
    publicOutputBoundaries,
    previewMarkdown: "",
    droppedPublicItems,
    privateOwnerContext: {
      itemCount: policyOutput.privateOwnerContext?.length ?? 0,
      includedInPublicPreview: false,
    },
    publication: {
      status: "preview_only",
      allowed: false,
      actions: [],
      reason: "Preview only; full export and publication remain outside this handoff.",
    },
  };

  preview.previewMarkdown = buildPreviewMarkdown(preview);

  if (!isRepoOnboardingPackPublicSafe(preview)) {
    preview.previewMarkdown =
      "Onboarding pack preview is unavailable because public text safety checks failed.";
  }

  return preview;
}

export function isRepoOnboardingPackPublicSafe(
  preview: Pick<
    RepoOnboardingPackPreview,
    | "contributionLanes"
    | "labelPolicy"
    | "validationExpectations"
    | "readinessWarnings"
    | "maintainerExpectations"
    | "publicOutputBoundaries"
    | "previewMarkdown"
    | "publication"
  >,
): boolean {
  const publicValues = [
    preview.previewMarkdown,
    preview.publication.reason,
    ...preview.contributionLanes.flatMap((lane) => [
      lane.id,
      lane.title,
      lane.summary,
      ...lane.preferredPaths,
      ...lane.discouragedPaths,
      ...lane.validationExpectations,
      ...lane.publicNotes,
    ]),
    ...preview.labelPolicy.preferredLabels,
    ...preview.labelPolicy.requiredLabels,
    ...preview.labelPolicy.discouragedLabels,
    preview.labelPolicy.note ?? "",
    ...preview.validationExpectations,
    ...preview.readinessWarnings,
    ...preview.maintainerExpectations,
    ...preview.publicOutputBoundaries,
  ];

  return publicValues.every(isFocusManifestPublicSafe);
}

function sanitizeContributionLane(
  lane: RepoPolicyContributionLane,
  index: number,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): RepoOnboardingContributionLane | null {
  const title = safePublicText(
    lane.title,
    `contributionLanes.${index}.title`,
    droppedPublicItems,
  );
  const summary = safePublicText(
    lane.summary,
    `contributionLanes.${index}.summary`,
    droppedPublicItems,
  );

  if (!title || !summary) {
    return null;
  }

  const id =
    safeOptionalPublicText(
      lane.id,
      `contributionLanes.${index}.id`,
      droppedPublicItems,
    ) ?? `lane-${index + 1}`;

  return {
    id: normalizeIdentifier(id, index),
    title,
    summary,
    preferredPaths: safePublicList(
      lane.preferredPaths,
      `contributionLanes.${index}.preferredPaths`,
      droppedPublicItems,
    ),
    discouragedPaths: safePublicList(
      lane.discouragedPaths,
      `contributionLanes.${index}.discouragedPaths`,
      droppedPublicItems,
    ),
    validationExpectations: safePublicList(
      lane.validationExpectations,
      `contributionLanes.${index}.validationExpectations`,
      droppedPublicItems,
    ),
    publicNotes: safePublicList(
      lane.publicNotes,
      `contributionLanes.${index}.publicNotes`,
      droppedPublicItems,
    ),
  };
}

function sanitizeLabelPolicy(
  labelPolicy: RepoPolicyLabelPolicy | undefined,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): RepoOnboardingLabelPolicy {
  return {
    preferredLabels: safePublicList(
      labelPolicy?.preferredLabels,
      "labelPolicy.preferredLabels",
      droppedPublicItems,
    ),
    requiredLabels: safePublicList(
      labelPolicy?.requiredLabels,
      "labelPolicy.requiredLabels",
      droppedPublicItems,
    ),
    discouragedLabels: safePublicList(
      labelPolicy?.discouragedLabels,
      "labelPolicy.discouragedLabels",
      droppedPublicItems,
    ),
    note: safeOptionalPublicText(
      labelPolicy?.note,
      "labelPolicy.note",
      droppedPublicItems,
    ),
  };
}

function withDefaultPublicList(
  values: string[] | undefined,
  defaults: string[],
  field: string,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): string[] {
  const safeValues = safePublicList(values, field, droppedPublicItems);
  return safeValues.length > 0 ? safeValues : defaults;
}

function safePublicList(
  values: string[] | undefined,
  field: string,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): string[] {
  if (!values) {
    return [];
  }

  return values
    .map((value, index) =>
      safePublicText(value, `${field}.${index}`, droppedPublicItems),
    )
    .filter((value): value is string => value !== null);
}

function safePublicText(
  value: string | null | undefined,
  field: string,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): string | null {
  const normalized = normalizeText(value);

  if (!normalized) {
    droppedPublicItems.push({ field, reason: "empty" });
    return null;
  }

  if (!isFocusManifestPublicSafe(normalized)) {
    droppedPublicItems.push({ field, reason: "unsafe_public_text" });
    return null;
  }

  return normalized;
}

function safeOptionalPublicText(
  value: string | null | undefined,
  field: string,
  droppedPublicItems: RepoOnboardingDroppedPublicItem[],
): string | null {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (!isFocusManifestPublicSafe(normalized)) {
    droppedPublicItems.push({ field, reason: "unsafe_public_text" });
    return null;
  }

  return normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeIdentifier(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : `lane-${index + 1}`;
}

function buildPreviewMarkdown(preview: RepoOnboardingPackPreview): string {
  const lines = [
    `# ${preview.repoFullName} onboarding pack preview`,
    "",
    "Status: preview only. No GitHub publication is performed.",
    "",
    "## Contribution lanes",
  ];

  if (preview.contributionLanes.length === 0) {
    lines.push("- Maintainer-approved work only.");
  } else {
    preview.contributionLanes.forEach((lane) => {
      lines.push(`- ${lane.title}: ${lane.summary}`);
      appendNestedList(lines, "Preferred paths", lane.preferredPaths);
      appendNestedList(lines, "Validation", lane.validationExpectations);
      appendNestedList(lines, "Notes", lane.publicNotes);
    });
  }

  lines.push("", "## Label policy");
  appendFlatList(lines, "Preferred", preview.labelPolicy.preferredLabels);
  appendFlatList(lines, "Required", preview.labelPolicy.requiredLabels);
  appendFlatList(lines, "Discouraged", preview.labelPolicy.discouragedLabels);
  if (preview.labelPolicy.note) {
    lines.push(`- Note: ${preview.labelPolicy.note}`);
  }

  lines.push("", "## Validation expectations");
  appendFlatList(lines, "Expected", preview.validationExpectations);

  if (preview.readinessWarnings.length > 0) {
    lines.push("", "## Readiness warnings");
    appendFlatList(lines, "Warning", preview.readinessWarnings);
  }

  lines.push("", "## Maintainer expectations");
  appendFlatList(lines, "Expectation", preview.maintainerExpectations);

  lines.push("", "## Public output boundaries");
  appendFlatList(lines, "Boundary", preview.publicOutputBoundaries);

  return lines.join("\n");
}

function appendNestedList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }

  lines.push(`  - ${label}: ${values.join(", ")}`);
}

function appendFlatList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }

  values.forEach((value) => {
    lines.push(`- ${label}: ${value}`);
  });
}
