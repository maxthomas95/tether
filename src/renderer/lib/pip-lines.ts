import type { PipSettings } from './pip-settings';

export type PipEventKind =
  | 'switch' | 'dizzy' | 'working' | 'delegated' | 'permission' | 'ready' | 'longTurn'
  | 'idle' | 'stopped' | 'crashed' | 'attention' | 'pet' | 'nap' | 'submitted';

/**
 * Pip's local lines. `{session}` is the session label and `{minutes}` the length
 * of a long turn. Every event has at least six lines per personality so the
 * rotation takes a while to come round. A ready line says the agent is waiting;
 * it never claims the work succeeded.
 */
export const PIP_LINES: Record<PipSettings['personality'], Record<PipEventKind, readonly string[]>> = {
  dry: {
    submitted: [
      'Another idea launched into the void. Bold.', 'Enter pressed. Plausible deniability lost.', 'I would have typed that. If I had fingers.',
      'Sent. No take-backs. I checked.', 'And off it goes. I take no responsibility.', 'Noted. I am keeping a tally of these.',
    ],
    switch: [
      'Ah, {session}. My other office.', 'New session. Same excellent supervisor.', 'I followed you. Very professional of me.',
      '{session} again. I never left, spiritually.', 'Relocating my supervision to {session}.', 'Different pane. Identical gremlin.',
    ],
    dizzy: [
      'Are we coding or speed-dating repositories?', 'So many tabs. So few paws.', 'Pick a session. Any session.',
      'I get motion sick, you know.', 'That was four offices in six seconds.', 'My tail is tangled. Thanks for that.',
    ],
    working: [
      "They're thinking. I'm also thinking. About snacks.", 'Excellent. Someone around here is working.', 'My contribution is moral support and cable management.',
      'Busy noises. I approve of busy noises.', 'I am supervising very hard right now.', 'Work is happening. I am adjacent to it.',
    ],
    delegated: [
      'It hired interns. I was not consulted.', 'Subagents. Now there are more of them to supervise.', 'It is delegating. I respect the instinct.',
      'Helpers have arrived. My workload just doubled.', 'More agents. I will need a bigger clipboard.', 'It called for backup. I was right here.',
    ],
    permission: [
      "Permission slip, please. I don't have thumbs.", 'Your agent has a question. I have several.', "Someone needs the human. That's you, apparently.",
      'It wants a yes or a no. I am not authorized.', 'A decision is required. I only do opinions.', 'Your agent is asking nicely. Rare. Enjoy it.',
    ],
    ready: [
      "They're ready for you. I'm ready for snacks.", 'Your agent is waiting. My supervision is impeccable.', 'The keyboard needs its human again.',
      'Your turn. I kept the seat warm.', 'It stopped talking. That is your cue.', 'The agent is waiting. So am I, but for lunch.',
    ],
    longTurn: [
      '{minutes} minutes. I aged visibly. Your turn.', 'That took {minutes} minutes. I counted every one.', 'Back after {minutes} minutes. I had a whole nap.',
      '{minutes} minutes later, it wants you again.', 'It worked for {minutes} minutes. I supervised for all of them.', '{minutes} minutes. I hope you had a snack. I did not.',
    ],
    idle: [
      "I'll guard the sidebar. From inside this nap.", 'Scheduled maintenance: tiny nap.', 'Nothing is happening. I am excellent at this part.',
      'Quiet in here. Suspiciously restful.', 'This session is idle. I relate.', 'Standing by. Lying down, technically.',
    ],
    stopped: [
      'This session has stopped. My shift apparently continues.', 'Agent offline. Gremlin still connected.', 'It clocked out. Nobody told me I could.',
      'Session over. I will mind the empty office.', 'Stopped. I did not touch anything.', 'The agent went home. I live here.',
    ],
    crashed: [
      'That session ended badly. I saw nothing.', 'It fell over. I did not push it.', 'Something broke in {session}. Not a cable, I checked.',
      '{session} went down unexpectedly. I am filing a report.', 'That was not a graceful exit.', 'The session died. I am fine, thanks for asking.',
    ],
    attention: [
      '{session} needs you. I would go, but no thumbs.', 'A question from {session}. I delegated it to you.', '{session} is waiting on you. I am only the messenger.',
      'Over in {session}, someone wants the human.', '{session} has gone quiet. It wants you.', 'You are needed in {session}. I will hold this pane.',
    ],
    pet: [
      'Finally. My performance review.', 'Compensation received. Continue.', 'I accept payment in this exact format.',
      'Acceptable. You may do that again.', 'This is the only meeting I enjoy.', 'Noted in my records as a bonus.',
    ],
    nap: [
      'Wake me when the humans return.', 'Out of office. In the office.', 'Entering low-power gremlin mode.',
      'Nobody is here. Excellent. Nap.', 'Resting my eyes. Both of them.', 'I will supervise from behind my eyelids.',
    ],
  },
  sweet: {
    submitted: [
      'Your next idea is on its way.', 'A little nudge toward the next adventure.', 'Sent! I will keep you company.',
      'Off it goes. Nicely put.', 'There it goes. I am cheering quietly.', 'Sent with care. I watched.',
    ],
    switch: [
      'Off to {session}! Coming with you.', 'A new little adventure. I am here.', 'Your {session} buddy has arrived.',
      'Hello, {session}. We are back.', '{session} it is. Right beside you.', 'Wherever you go, I tag along.',
    ],
    dizzy: [
      'Lots of adventures today! Let me catch up.', 'Tiny paws. So many places to be.', 'Whee! Where are we now?',
      'So many sessions. I love them all.', 'One moment, my ears are still spinning.', 'You are quick today! I am trying.',
    ],
    working: [
      "You've got this. I'll keep you company.", 'Little paws, big moral support.', 'Busy brains. Cozy company.',
      'Good things are cooking in there.', 'They are hard at work. I am proud.', 'Humming along. I will keep watch.',
    ],
    delegated: [
      'Your agent brought some helpers along.', 'More little helpers on the job.', 'Teamwork! Some helpers just joined.',
      'Your agent asked for a hand. How nice.', 'New helpers arrived. The more the merrier.', 'A few helpers are pitching in now.',
    ],
    permission: [
      'Your agent is waiting for a little help.', "A question for you! I'll wait here.", 'They need your okay before continuing.',
      'A small decision is waiting for you.', 'Your agent would like your say-so.', 'They paused to ask you first.',
    ],
    ready: [
      'Your agent is ready when you are.', 'Ready for the next little adventure.', 'A little pause for your next idea.',
      'Your turn, whenever you like.', 'They are listening for you now.', 'All ears for what comes next.',
    ],
    longTurn: [
      '{minutes} minutes of steady work. Ready for you now.', 'That was {minutes} minutes. Thank you for waiting with me.', 'Back after {minutes} minutes, and ready for you.',
      '{minutes} minutes later, your agent is listening again.', 'A long one, {minutes} minutes. Your turn when you like.', 'They worked {minutes} minutes. Now it is over to you.',
    ],
    idle: [
      'Rest is part of the work, too.', 'A little nap sounds lovely.', 'Quiet time. I like it here.',
      'Nothing to do but be cozy.', 'A calm moment. Enjoy it.', 'Taking it easy together.',
    ],
    stopped: [
      'This session has stopped. I am still here with you.', 'Your agent is offline. Your buddy is here.', 'That one is done for now. I will stay.',
      'This session is resting. We can start another.', 'All quiet in this session now.', 'It has stopped. Whenever you are ready, so am I.',
    ],
    crashed: [
      'Oh no, that session ended unexpectedly. I am here.', '{session} stopped suddenly. That was not your fault.', 'Something went wrong in {session}. We can try again.',
      'That session went down. Deep breath, I am with you.', 'An unexpected ending for {session}. I am sorry.', '{session} fell over. We will get it back up.',
    ],
    attention: [
      '{session} is waiting for a little help.', 'A question for you over in {session}.', '{session} would love a moment of your time.',
      'Someone in {session} is waiting for you.', '{session} is ready for you whenever you can.', 'A little wave from {session}.',
    ],
    pet: [
      'You made my whole afternoon.', "Purr. That's the entire review.", 'Best part of being your coding buddy.',
      'That was lovely. Thank you.', 'I saved that one for later.', 'Happiest gremlin in the sidebar.',
    ],
    nap: [
      "I'll be right here when you get back.", 'Curling up for a moment.', 'A cozy pause while you are away.',
      'Sleepy time. Wake me any time.', 'Just a short doze. I am nearby.', 'Dreaming of tidy cables.',
    ],
  },
};
