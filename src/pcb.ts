// Generated contract snapshot from fabplane.com/packages/shared/src/pcb-workflow.ts. No persistence logic.
import { z } from "zod/v4";
const text = (n: number) => z.string().trim().min(1).max(n);
export const workflowStages = [
  "unknown",
  "design",
  "review",
  "manufacturing",
  "validation",
  "released",
  "retired",
] as const;
export const evidenceSchema = z
  .object({
    source: text(2000),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    observedAt: z.iso.datetime(),
    verification: z.enum(["documented", "unverified", "verified"]),
    note: text(4000),
  })
  .strict();
export const blockerSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["firmware", "parts", "mechanical", "electrical", "other"]),
    reason: text(2000),
    owner: text(120),
    nextAction: text(2000),
    dependencies: z.array(z.uuid()).max(30),
    resolved: z.boolean(),
  })
  .strict();
export const boardInput = z
  .object({
    key: text(120).regex(/^[a-z0-9][a-z0-9._:-]*$/),
    name: text(160),
    description: z.string().max(4000).default(""),
    // Linking a project must never grant additional access. This slice leaves private project links out.
    provenance: z.array(evidenceSchema).max(30).default([]),
  })
  .strict();
export const revisionInput = z
  .object({
    key: text(120).regex(/^[a-z0-9][a-z0-9._:-]*$/),
    label: text(120),
    stage: z.enum(workflowStages).default("unknown"),
    owner: z.string().max(120).default(""),
    nextAction: z.string().max(2000).default(""),
    blockers: z.array(blockerSchema).max(30).default([]),
    provenance: z.array(evidenceSchema).max(30).default([]),
  })
  .strict();
// PUT replaces one complete record: omitted fields must never silently erase blockers/evidence.
export const revisionUpdate = revisionInput
  .omit({ key: true })
  .extend({
    stage: revisionInput.shape.stage.removeDefault(),
    owner: revisionInput.shape.owner.removeDefault(),
    nextAction: revisionInput.shape.nextAction.removeDefault(),
    blockers: revisionInput.shape.blockers.removeDefault(),
    provenance: revisionInput.shape.provenance.removeDefault(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const orderInput = z
  .object({
    key: text(120).regex(/^[a-z0-9][a-z0-9._:-]*$/),
    vendor: text(120),
    reference: text(160),
    batch: z.string().max(160).default(""),
    status: z
      .enum([
        "unknown",
        "placed",
        "pcb",
        "assembly",
        "shipped",
        "delivered",
        "received",
        "cancelled",
      ])
      .default("unknown"),
    quantity: z.number().int().positive().max(100000).nullable().default(null),
    pcbPercent: z.number().min(0).max(100).nullable().default(null),
    assemblyPercent: z.number().min(0).max(100).nullable().default(null),
    estimatedArrival: z.iso.date().nullable().default(null),
    physicalReceipt: z.enum(["unverified", "verified"]).default("unverified"),
    functionalValidation: z
      .enum(["unverified", "passed", "failed"])
      .default("unverified"),
    provenance: z.array(evidenceSchema).min(1).max(30),
  })
  .strict()
  .refine(
    (v) => v.status !== "received" || v.physicalReceipt === "verified",
    "received requires verified physical receipt",
  );
export const orderUpdate = orderInput.safeExtend({
  batch: orderInput.shape.batch.removeDefault(),
  status: orderInput.shape.status.removeDefault(),
  quantity: orderInput.shape.quantity.removeDefault(),
  pcbPercent: orderInput.shape.pcbPercent.removeDefault(),
  assemblyPercent: orderInput.shape.assemblyPercent.removeDefault(),
  estimatedArrival: orderInput.shape.estimatedArrival.removeDefault(),
  physicalReceipt: orderInput.shape.physicalReceipt.removeDefault(),
  functionalValidation: orderInput.shape.functionalValidation.removeDefault(),
  expectedVersion: z.number().int().positive(),
});
export type BoardInput = z.output<typeof boardInput>;
export type RevisionInput = z.output<typeof revisionInput>;
export type OrderInput = z.output<typeof orderInput>;
export type Revision = RevisionInput & {
  id: string;
  boardId: string;
  version: number;
};
export type Order = OrderInput & {
  id: string;
  revisionId: string;
  version: number;
};
export type Board = BoardInput & { id: string };
export type Workflow = {
  boards: Board[];
  revisions: Revision[];
  orders: Order[];
};
export const importPreviewInput = z
  .object({
    candidates: z
      .array(z.object({ board: boardInput, revision: revisionInput }).strict())
      .max(500),
  })
  .strict();
