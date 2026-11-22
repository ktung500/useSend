import { Queue, Worker } from "bullmq";
import { createWorkerHandler, TeamJob } from "../queue/bullmq-context";
import { DEFAULT_QUEUE_OPTIONS, SEQUENCE_SCHEDULER_QUEUE } from "../queue/queue-constants";
import { getRedis, BULL_PREFIX } from "../redis";
import { processDueEnrollments } from "../service/sequence-service";
import { logger } from "../logger/log";

// Fork: sends due sequence steps. Postgres holds the timing; this only ticks.
const SCHEDULER_TICK_MS = 30_000;

type SchedulerJob = TeamJob<{}>;

export class SequenceSchedulerService {
  private static schedulerQueue = new Queue<SchedulerJob>(SEQUENCE_SCHEDULER_QUEUE, {
    connection: getRedis(),
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  static worker = new Worker(
    SEQUENCE_SCHEDULER_QUEUE,
    createWorkerHandler(async (_job: SchedulerJob) => {
      try {
        const processed = await processDueEnrollments();
        if (processed > 0) logger.info({ processed }, "Sequence scheduler tick");
      } catch (err) {
        logger.error({ err }, "Sequence scheduler tick failed");
      }
    }),
    { connection: getRedis(), concurrency: 1, prefix: BULL_PREFIX, skipVersionCheck: true },
  );

  static async start() {
    try {
      await this.schedulerQueue.add(
        "tick",
        {},
        { jobId: "sequence-scheduler", repeat: { every: SCHEDULER_TICK_MS }, ...DEFAULT_QUEUE_OPTIONS },
      );
    } catch (err) {
      // Adding the same repeatable job is idempotent; ignore job-exists errors
      logger.info({ err }, "Sequence scheduler start attempted");
    }
  }
}
