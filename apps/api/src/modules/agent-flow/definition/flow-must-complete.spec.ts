import {
  flowMustCompleteBefore,
  type FlowNode,
} from '@litter-bear/types/agent-flow';

/**
 * 共享的「必定已完成」分析
 * @description 这个函数住在 `packages/types`（后端 validator 与管理端画布必须给出同一个答案，
 * 因此只有一份实现），而那个包没有测试设施。放在这里是因为 api 侧有 jest，且它是本仓库里
 * 唯一以运行时正确性依赖该分析的地方——判错就是让 $ref 在运行时取到空值。
 *
 * 重点覆盖并行语义：它**不是**教科书支配集。支配集假设「多条出边只走一条」，那对 condition
 * 成立、对并行扇出不成立。
 */
describe('flowMustCompleteBefore', () => {
  /**
   * 构造一个测试节点
   * @param id 节点标识
   * @param type 节点类型
   * @param config 该类型所需的最小配置
   * @returns 返回可交给分析函数的节点
   */
  function node(id: string, type: string, config: unknown = {}): FlowNode {
    // 分析只读 id / type / join 的 config，其余字段与它无关；构造完整合法节点会让
    // 用例被无关配置淹没
    return { id, type, config } as unknown as FlowNode;
  }

  /**
   * 取出某节点前置的必完成集合
   * @param nodes 图中全部节点
   * @param edges 图中全部边
   * @param probe 待查节点
   * @returns 返回排序后的节点标识（不含自身）
   */
  function before(
    nodes: FlowNode[],
    edges: Array<{ from: string; to: string; when?: string }>,
    probe: string,
  ): string[] {
    const set = flowMustCompleteBefore(nodes, edges).get(probe);
    return [...(set ?? [])].filter((id) => id !== probe).sort();
  }

  it('串行链路上的全部上游都有保证', () => {
    expect(
      before(
        [node('start', 'start'), node('a', 'agent'), node('b', 'agent')],
        [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'b' },
        ],
        'b',
      ),
    ).toEqual(['a', 'start']);
  });

  it('condition 的互斥分支在汇聚点都没有保证', () => {
    // 只走一条分支，因此汇聚点不能引用任一分支的输出——这是交集要排除的情形
    expect(
      before(
        [
          node('start', 'start'),
          node('c', 'condition', { cases: [] }),
          node('x', 'agent'),
          node('y', 'agent'),
          node('z', 'agent'),
        ],
        [
          { from: 'start', to: 'c' },
          { from: 'c', to: 'x' },
          { from: 'c', to: 'y' },
          { from: 'x', to: 'z' },
          { from: 'y', to: 'z' },
        ],
        'z',
      ),
    ).toEqual(['c', 'start']);
  });

  it('join(all) 保证所有被等分支都已完成', () => {
    // 教科书支配集在这里会求交集、把两条分支都丢掉。并行扇出的多条 default 边是**全都走**的，
    // 因此 all 语义下它们各自的前置都有保证。
    expect(
      before(
        [
          node('start', 'start'),
          node('p', 'agent'),
          node('q', 'agent'),
          node('j', 'join', { waitFor: ['p', 'q'], policy: 'all' }),
        ],
        [
          { from: 'start', to: 'p' },
          { from: 'start', to: 'q' },
          { from: 'p', to: 'j' },
          { from: 'q', to: 'j' },
        ],
        'j',
      ),
    ).toEqual(['p', 'q', 'start']);
  });

  it('join(any) 只保证公共前置', () => {
    // 同一张图换成 any：任一分支完成即继续，因此另一条可能还没跑完
    expect(
      before(
        [
          node('start', 'start'),
          node('p', 'agent'),
          node('q', 'agent'),
          node('j', 'join', { waitFor: ['p', 'q'], policy: 'any' }),
        ],
        [
          { from: 'start', to: 'p' },
          { from: 'start', to: 'q' },
          { from: 'p', to: 'j' },
          { from: 'q', to: 'j' },
        ],
        'j',
      ),
    ).toEqual(['start']);
  });

  it('并行分支之间互不保证', () => {
    // 并发不等于已完成：p 执行时 q 可能还在跑，引用 q 的输出会取到空值
    expect(
      before(
        [
          node('start', 'start'),
          node('p', 'agent'),
          node('q', 'agent'),
          node('j', 'join', { waitFor: ['p', 'q'], policy: 'all' }),
        ],
        [
          { from: 'start', to: 'p' },
          { from: 'start', to: 'q' },
          { from: 'p', to: 'j' },
          { from: 'q', to: 'j' },
        ],
        'p',
      ),
    ).toEqual(['start']);
  });

  it('join 之后的节点继承 join 的保证', () => {
    expect(
      before(
        [
          node('start', 'start'),
          node('p', 'agent'),
          node('q', 'agent'),
          node('j', 'join', { waitFor: ['p', 'q'], policy: 'all' }),
          node('tail', 'agent'),
        ],
        [
          { from: 'start', to: 'p' },
          { from: 'start', to: 'q' },
          { from: 'p', to: 'j' },
          { from: 'q', to: 'j' },
          { from: 'j', to: 'tail' },
        ],
        'tail',
      ),
    ).toEqual(['j', 'p', 'q', 'start']);
  });

  it('只按 waitFor 判定，不按入边判定', () => {
    // 这条区分「waitFor」与「全部前驱」：join 可以有三条入边却只等两条
    // （启动三条分支、等其中两条即继续）。用前驱代替 waitFor 会把没被等的那条也算成
    // 有保证，下游引用它就会取到空值。
    const nodes = [
      node('start', 'start'),
      node('p', 'agent'),
      node('q', 'agent'),
      node('r', 'agent'),
      node('j', 'join', { waitFor: ['p', 'q'], policy: 'all' }),
    ];
    const edges = [
      { from: 'start', to: 'p' },
      { from: 'start', to: 'q' },
      { from: 'start', to: 'r' },
      { from: 'p', to: 'j' },
      { from: 'q', to: 'j' },
      { from: 'r', to: 'j' },
    ];

    // r 连到了 j 但不在 waitFor 里，因此没有完成保证
    expect(before(nodes, edges, 'j')).toEqual(['p', 'q', 'start']);
  });

  it('策略读不出来时缺省到 any，不虚报保证', () => {
    // 缺省方向是安全性的一部分：缺省到 all 会对分支求并集、宣称它们都已完成，
    // 而若实际是 any，下游引用就会在运行时取到空值。缺省到 any 只会少给保证。
    const nodes = [
      node('start', 'start'),
      node('p', 'agent'),
      node('q', 'agent'),
      // config 形状不完整（草稿常见），策略读不出来
      node('j', 'join', { waitFor: ['p', 'q'] }),
    ];
    const edges = [
      { from: 'start', to: 'p' },
      { from: 'start', to: 'q' },
      { from: 'p', to: 'j' },
      { from: 'q', to: 'j' },
    ];

    expect(before(nodes, edges, 'j')).toEqual(['start']);
  });

  it('入口不唯一时返回空映射，不给出可能错的结论', () => {
    // 草稿常处于这种中间态；给一个「看起来对」的答案比给不出答案更危险
    expect(
      flowMustCompleteBefore([node('a', 'agent'), node('b', 'agent')], []).size,
    ).toBe(0);
  });

  it('合法 loop 按单轮展开计算，不把体内输出泄漏到 done 侧', () => {
    const nodes = [
      node('start', 'start'),
      node('lp', 'loop'),
      node('body', 'agent'),
      node('tail', 'agent'),
    ];
    const edges = [
      { from: 'start', to: 'lp' },
      { from: 'lp', to: 'body', when: 'again' },
      { from: 'body', to: 'lp' },
      { from: 'lp', to: 'tail', when: 'done' },
    ];

    expect(before(nodes, edges, 'body')).toEqual(['lp', 'start']);
    expect(before(nodes, edges, 'tail')).toEqual(['lp', 'start']);
  });
});
