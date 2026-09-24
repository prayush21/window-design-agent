import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, resolveConfig } from "../config.js";
import { evalPaths, listRoomPhotos } from "../../eval/label-api.js";
import { runSession } from "../engine.js";
import { createSession, loadSession } from "../session.js";

const USAGE = `Usage: npm run v2:run -- [options]

  --all                   every room photo in evals/rooms
  --room <id>             one room (file name without extension)
  --text "<prefs>"        free-text preferences for the Brief
  --room-type <type>      state the room type (e.g. bedroom, nursery)
  --mock                  force mock mode (default unless DESIGN_AGENT_LIVE=1)
  --live                  live mode; refused unless DESIGN_AGENT_LIVE=1 is set
  --baseline              every model stage uses its no-model baseline
  --orchestrator <name>   default: workflow
  --resume <session.json> continue a saved session from its cursor
  --react '<json>'        with --resume: apply a reaction first, e.g. '{"kind":"feedback","text":"warmer"}'
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || (!args.all && !args.room && !args.resume)) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }

  const mode = args.baseline ? "baseline" : args.live ? "live" : args.mock ? "mock" : undefined;
  const config = resolveConfig(mode ? { mode } : {});
  process.stdout.write(`\nv2 ${args.orchestrator} · mode ${config.mode}${config.mode === "live" ? " · PAID CALLS" : " · no paid calls"}\n\n`);

  const jobs = [];
  if (args.resume) {
    const session = loadSession(path.resolve(ROOT_DIR, args.resume));
    if (args.react) {
      session.pendingReaction = JSON.parse(args.react);
    }
    jobs.push(session);
  } else {
    const rooms = listRoomPhotos(evalPaths(ROOT_DIR).roomsDir).filter((room) => args.all || room.id === args.room);
    if (rooms.length === 0) {
      process.stderr.write(`No room matched "${args.room}".\n`);
      return 1;
    }
    for (const room of rooms) {
      jobs.push(
        createSession({
          roomPhotoPath: path.join("evals", room.photo),
          roomId: room.id,
          userInput: { text: args.text, roomType: args.roomType }
        })
      );
    }
  }

  let failures = 0;
  for (const session of jobs) {
    const label = session.input.roomPhoto.roomId || session.sessionId;
    try {
      const { traceFile } = await runSession(session, { config, orchestrator: args.orchestrator });
      process.stdout.write(`  ✓ ${label}  ${summarize(session)}\n    trace ${path.relative(ROOT_DIR, traceFile)}\n`);
      for (const warning of session.warnings) {
        process.stdout.write(`    ! [${warning.stage || "run"}] ${warning.code}: ${warning.message}\n`);
      }
    } catch (error) {
      failures += 1;
      process.stdout.write(`  ✗ ${label}  ${error.message}\n`);
      if (error.traceFile) process.stdout.write(`    trace ${path.relative(ROOT_DIR, error.traceFile)}\n`);
    }
  }

  process.stdout.write(`\n${jobs.length - failures}/${jobs.length} sessions completed.\n`);
  return failures > 0 ? 1 : 0;
}

function summarize(session) {
  const room = session.brief?.roomType;
  const parts = [
    room ? `${room.value} (${room.source})` : "no brief",
    `${session.directions.length} directions`,
    `${Object.keys(session.shortlists).length} shortlists`
  ];
  if (session.proposals.length > 0) parts.push(`${session.proposals.length} proposals`);
  if (session.renders.length > 0) parts.push(`${session.renders.length} renders`);
  if (session.presentation) parts.push(`${session.presentation.items.length} presented`);
  parts.push(`${session.warnings.length} warnings`);
  return parts.join(" · ");
}

function parseArgs(argv) {
  const args = { orchestrator: "workflow" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === "--all") args.all = true;
    else if (flag === "--room") args.room = next();
    else if (flag === "--text") args.text = next();
    else if (flag === "--room-type") args.roomType = next();
    else if (flag === "--mock") args.mock = true;
    else if (flag === "--live") args.live = true;
    else if (flag === "--baseline") args.baseline = true;
    else if (flag === "--orchestrator") args.orchestrator = next();
    else if (flag === "--resume") args.resume = next();
    else if (flag === "--react") args.react = next();
    else if (flag === "--help" || flag === "-h") args.help = true;
    else process.stderr.write(`Ignoring unknown flag "${flag}"\n`);
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`\n${error.stack || error.message}\n`);
      process.exit(1);
    }
  );
}

