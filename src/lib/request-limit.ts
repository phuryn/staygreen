/** One shared queue for a run's HTTP, TLS and DNS work, including derived endpoints. */
export function requestLimit(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  return <T>(task: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const run = () => {
      running++;
      task().then(resolve, reject).finally(() => { running--; queue.shift()?.(); });
    };
    if (running < max) run(); else queue.push(run);
  });
}
