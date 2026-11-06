// Data fetching for the trace command
// Loads requirement → design → plan → version → slice chain from stores

import { RequirementStore } from '../../../core/requirements/store.js';
import { DesignStore } from '../../../core/design/store.js';
import { deriveModules } from '../../../core/design/derive.js';
import { VersionStore } from '../../../core/version/store.js';
import { SliceStore } from '../../../core/slice/store.js';
import type {
  TraceData,
  TraceRequirement,
  TraceDesign,
  TracePlan,
  TraceVersion,
  TraceSlice,
} from './model.js';

/**
 * Fetch the full trace chain for a given requirement ID.
 * Returns null if the requirement is not found.
 */
export async function fetchTraceData(
  reqId: string,
  zeltoDir: string,
  slicesDir: string,
): Promise<TraceData | null> {
  const reqStore = new RequirementStore(zeltoDir);
  const designStore = new DesignStore(zeltoDir);
  const versionStore = new VersionStore(zeltoDir);
  const sliceStore = new SliceStore(slicesDir);

  if (!(await reqStore.exists(reqId))) {
    return null;
  }

  const req = await reqStore.read(reqId);
  const requirement: TraceRequirement = {
    id: req.id,
    title: req.title,
    status: req.status,
    acceptanceCriteria: req.acceptanceCriteria ?? [],
  };

  const allDesigns = await designStore.list();
  const matchingDesigns = allDesigns.filter((d) => d.requirementId === reqId);

  const designs: TraceDesign[] = [];
  for (const ds of matchingDesigns) {
    const design = await designStore.read(ds.id);

    const allPlans = await versionStore.list();
    const matchingPlans = (
      await Promise.all(allPlans.map((p) => versionStore.read(p.id)))
    ).filter((p) => p.designId === design.id);

    const plans: TracePlan[] = [];
    for (const plan of matchingPlans) {
      const versions: TraceVersion[] = [];
      for (const v of plan.versions) {
        const slices: TraceSlice[] = [];
        for (const s of v.slices) {
          let sliceState = '—';
          try {
            const sd = await sliceStore.read(s.id);
            sliceState = sd.state;
          } catch {
            // Slice not yet created
          }
          slices.push({
            id: s.id,
            title: s.title,
            module: s.module,
            state: sliceState,
          });
        }
        versions.push({
          version: v.version,
          status: v.status,
          description: v.description,
          slices,
        });
      }
      plans.push({
        id: plan.id,
        title: plan.title,
        status: plan.status,
        versions,
      });
    }

    designs.push({
      id: design.id,
      title: design.title,
      status: design.status,
      // 模块声明从正文推导（正文是真源），存的 modules 只是缓存
      modules: deriveModules(design).map((m) => ({
        name: m.name,
        description: m.description,
        dependencies: m.dependencies ?? [],
      })),
      plans,
    });
  }

  return { requirement, designs };
}
