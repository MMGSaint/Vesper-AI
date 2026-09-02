import type { StorageAdapter } from "../storage.ts";
import { KnowledgeGraph } from "./graph.ts";
import { InstinctStore } from "./instincts.ts";
import { JobStore } from "./jobs.ts";

/** One bag so the runtime grows one field, not three. */
export class PersonalIntelligence {
  readonly graph: KnowledgeGraph;
  readonly instincts: InstinctStore;
  readonly jobs: JobStore;

  constructor(storage: StorageAdapter) {
    this.graph = new KnowledgeGraph(storage);
    this.instincts = new InstinctStore(storage);
    this.jobs = new JobStore(storage);
  }
}
