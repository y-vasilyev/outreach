/**
 * Side-effect import: registers all 12 agents into `agentRegistry`.
 *
 * Importing this module from `packages/agents/src/index.ts` is enough; callers
 * that only need a specific agent's schemas can also import the file directly.
 */

import { agentRegistry } from '../registry.js';

import { channelAnalyzer } from './ChannelAnalyzer.js';
import { contactExtractor } from './ContactExtractor.js';
import { contactPrioritizer } from './ContactPrioritizer.js';
import { approachStrategist } from './ApproachStrategist.js';
import { openingComposer } from './OpeningComposer.js';
import { replyComposer } from './ReplyComposer.js';
import { intentClassifier } from './IntentClassifier.js';
import { safetyFilter } from './SafetyFilter.js';
import { handoffDecider } from './HandoffDecider.js';
import { goalFitEvaluator } from './GoalFitEvaluator.js';
import { conversationSummarizer } from './ConversationSummarizer.js';
import { nextActionPlanner } from './NextActionPlanner.js';
import { qualityReviewer } from './QualityReviewer.js';

agentRegistry.register(channelAnalyzer);
agentRegistry.register(contactExtractor);
agentRegistry.register(contactPrioritizer);
agentRegistry.register(approachStrategist);
agentRegistry.register(openingComposer);
agentRegistry.register(replyComposer);
agentRegistry.register(intentClassifier);
agentRegistry.register(safetyFilter);
agentRegistry.register(handoffDecider);
agentRegistry.register(goalFitEvaluator);
agentRegistry.register(conversationSummarizer);
agentRegistry.register(nextActionPlanner);
agentRegistry.register(qualityReviewer);

export {
  channelAnalyzer,
  contactExtractor,
  contactPrioritizer,
  approachStrategist,
  openingComposer,
  replyComposer,
  intentClassifier,
  safetyFilter,
  handoffDecider,
  goalFitEvaluator,
  conversationSummarizer,
  nextActionPlanner,
  qualityReviewer,
};

export * from './ChannelAnalyzer.js';
export * from './ContactExtractor.js';
export * from './ContactPrioritizer.js';
export * from './ApproachStrategist.js';
export * from './OpeningComposer.js';
export * from './ReplyComposer.js';
export * from './IntentClassifier.js';
export * from './SafetyFilter.js';
export * from './HandoffDecider.js';
export * from './GoalFitEvaluator.js';
export * from './ConversationSummarizer.js';
export * from './NextActionPlanner.js';
export * from './QualityReviewer.js';
