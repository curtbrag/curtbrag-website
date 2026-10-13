// Apply the platform limit before password verification and session writes.
export default () => undefined;
export const config = {
  rateLimit: { windowLimit: 10, windowSize: 180, aggregateBy: ['ip', 'domain'] },
  onError: 'fail',
};
