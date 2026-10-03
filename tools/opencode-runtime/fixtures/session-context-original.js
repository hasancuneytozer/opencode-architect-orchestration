import {
  Service84,
  node88
} from "./config-yds56wag.js";
import {
  Service80,
  node84
} from "./config-vyy061a2.js";
import {
  VariantID2,
  Ref2,
  Service68,
  node71
} from "./config-2e655exz.js";
import {
  ID10,
  Service62,
  node65
} from "./config-tats7t1r.js";
import {
  AgentNotFoundError2
} from "./config-7h7s3rmt.js";
import {
  combine2
} from "./config-rhjbct0v.js";
import {
  provenance2
} from "./config-1rn5pcm9.js";
import {
  entriesForRunner2
} from "./config-9dh8p3yq.js";
import {
  Service50,
  node52
} from "./config-sd0msgcy.js";
import {
  merge2
} from "./config-vgpkvtp0.js";
import {
  make13
} from "./config-nrp9mwhy.js";
import {
  Service69,
  node72
} from "./config-smj4rr9q.js";
import {
  Service33,
  node36
} from "./config-w3xn08qs.js";
import {
  Service59,
  node61
} from "./config-yw6qsgb4.js";
import {
  Service31,
  node34
} from "./config-vhs69wxs.js";
import {
  Service30,
  node33
} from "./config-bamqybry.js";
import {
  Service39,
  node42
} from "./config-m7ph8gga.js";
import {
  Service29,
  node32
} from "./config-e99cgfzf.js";
import {
  Service38,
  node41
} from "./config-cpfpew26.js";
import {
  Service35,
  node39
} from "./config-f390r7qs.js";
import {
  Service48,
  node50
} from "./config-5zdms79f.js";
import {
  __export
} from "./config-9rqn6x4v.js";

// src/session/context.ts
var exports_context = {};
__export(exports_context, {
  Service: () => Service28,
  SessionContext: () => exports_context,
  node: () => node31
});
import { Context, Effect, Layer } from "effect";
import { makeLocationNode } from "@opencode/util/effect/app-node";
class Service28 extends Context.Service()("@opencode/SessionContext") {
}
var layer = Layer.effect(Service28, Effect.gen(function* () {
  const agents = yield* Service62;
  const builtins = yield* Service33;
  const model = yield* Service68;
  const db = (yield* Service84).db;
  const discovery = yield* Service69;
  const entries = yield* Service38;
  const location = yield* Service80;
  const mcpInstructions = yield* Service30;
  const mcpTools = yield* Service31;
  const models = yield* Service48;
  const request = yield* Service35;
  const referenceInstructions = yield* Service39;
  const skillInstructions = yield* Service29;
  const store = yield* Service50;
  const registry = yield* Service59;
  const resolveModel = (session) => models.resolve(session, model.available);
  const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session) {
    const agent = yield* agents.get(ID10.make("title"));
    if (!agent)
      return;
    const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => {
      return;
    }));
    const info = yield* Effect.gen(function* () {
      if (agent.model)
        return yield* model.get(agent.model.providerID, agent.model.id);
      if (!primary)
        return;
      return yield* model.small(primary.ref.providerID);
    });
    const variant = agent.model?.variant ?? MINIMAL_REASONING_VARIANTS.find((id) => info?.variants.some((item) => item.id === id));
    const preferred = info && (yield* resolveModel({
      ...session,
      model: Ref2.make({
        providerID: info.providerID,
        id: info.id,
        ...variant ? { variant } : {}
      })
    }).pipe(Effect.orElseSucceed(() => {
      return;
    })));
    const selected = preferred ?? primary;
    if (!selected)
      return;
    return { agent, primary, selected };
  });
  const select = Effect.fn("SessionContext.select")(function* (sessionID) {
    const session = yield* store.get(sessionID);
    if (!session)
      return yield* Effect.die(new Error(`Session not found: ${sessionID}`));
    if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
      return yield* Effect.interrupt;
    yield* mcpTools.flush;
    const agent = yield* agents.select(session.agent);
    if (!agent.info)
      return yield* new AgentNotFoundError2({ sessionID: session.id, agent: session.agent ?? agent.id });
    const permissions = merge2(agent.info.permissions, session.permissions ?? []);
    const loaded = yield* Effect.all({
      tools: registry.snapshot(permissions),
      builtins: builtins.load(sessionID),
      discovery: discovery.load(),
      skills: skillInstructions.load(permissions),
      references: referenceInstructions.load(),
      mcp: mcpInstructions.load(permissions),
      entries: entries.load(sessionID)
    }, { concurrency: "unbounded" });
    return {
      session,
      agent: { ...agent, info: agent.info },
      instructions: combine2([
        loaded.builtins,
        make13(loaded.tools.codeModeCatalog),
        loaded.discovery,
        loaded.skills,
        loaded.references,
        loaded.mcp,
        loaded.entries
      ]),
      tools: loaded.tools
    };
  });
  const load = Effect.fn("SessionContext.load")(function* (selection) {
    const model = yield* resolveModel(selection.session);
    const history = yield* entriesForRunner2(db, selection.session.id, selection.instructions, provenance2(model) ?? "local");
    return {
      session: selection.session,
      agent: selection.agent,
      model,
      initial: history.initial,
      messages: history.entries.map((entry) => entry.message),
      tools: selection.tools
    };
  });
  return Service28.of({ select, load, resolveModel, selectTitle, request });
}));
var MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => VariantID2.make(id));
var node31 = makeLocationNode({
  service: Service28,
  layer,
  deps: [
    node65,
    node71,
    node88,
    node36,
    node72,
    node41,
    node84,
    node33,
    node34,
    node42,
    node50,
    node39,
    node52,
    node32,
    node61
  ]
});

export { Service28, node31, exports_context };
