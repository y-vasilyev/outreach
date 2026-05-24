import { Queue } from 'bullmq';
import { QueueNames } from '@nosquare/shared';
import { getRedis } from './redis.js';

const conn = () => ({ connection: getRedis() });

interface QueueMap {
  channelScrape: Queue;
  contactExtract: Queue;
  tgSend: Queue;
  agentRun: Queue;
  followupCron: Queue;
  metricsRoll: Queue;
  discoveryBatch: Queue;
}

let _queues: QueueMap | undefined;

export function getQueues(): QueueMap {
  if (!_queues) {
    _queues = {
      channelScrape: new Queue(QueueNames.channelScrape, conn()),
      contactExtract: new Queue(QueueNames.contactExtract, conn()),
      tgSend: new Queue(QueueNames.tgSend, conn()),
      agentRun: new Queue(QueueNames.agentRun, conn()),
      followupCron: new Queue(QueueNames.followupCron, conn()),
      metricsRoll: new Queue(QueueNames.metricsRoll, conn()),
      discoveryBatch: new Queue(QueueNames.discoveryBatch, conn()),
    };
  }
  return _queues;
}
