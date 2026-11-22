/** Answer feedback shared by the route and the client: the rating, and the reasons a 👎 can name.
 *  The reasons are root-cause hints for later analysis of research traces, so each names a failure
 *  of the research rather than a matter of taste — except `tooLong`, kept apart as the one about form. */

export const FEEDBACK_REASONS = ['wrong', 'outdated', 'badCitations', 'incomplete', 'offTopic', 'tooLong'] as const
export type FeedbackReason = typeof FEEDBACK_REASONS[number]

export const FEEDBACK_COMMENT_MAX = 2000

export interface MessageFeedback {
  /** 1 for 👍, -1 for 👎, null when only a reason or comment was left. */
  rating: 1 | -1 | null
  reasons: FeedbackReason[]
  comment: string
}
