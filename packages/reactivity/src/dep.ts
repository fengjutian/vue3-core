// Vue 3响应式系统 - 依赖收集与触发模块
// 此模块实现了Vue 3响应式系统中的依赖收集和触发机制，是响应式系统的核心组成部分

import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared' // 共享工具函数
import type { ComputedRefImpl } from './computed' // 计算属性引用实现类型
import { type TrackOpTypes, TriggerOpTypes } from './constants' // 追踪和触发操作类型
import {
  type DebuggerEventExtraInfo,
  EffectFlags,
  type Subscriber,
  activeSub,
  endBatch,
  shouldTrack,
  startBatch,
} from './effect' // 副作用相关导入

/**
 * 全局版本号，每次响应式变化时递增
 * 用于计算属性的快速路径，避免在没有任何变化时重新计算
 */
export let globalVersion = 0

/**
 * 表示源(Dep)和订阅者(Effect或Computed)之间的链接
 * Deps和subs是多对多关系 - 每个dep和sub之间的链接由一个Link实例表示
 *
 * Link同时也是两个双向链表中的节点:
 * 1. 一个用于关联的sub跟踪其所有deps
 * 2. 一个用于关联的dep跟踪其所有subs
 *
 * @internal
 */
export class Link {
  /**
   * 版本号，用于跟踪依赖是否被使用
   * - 在每次副作用运行前，所有之前的dep links的version都会重置为-1
   * - 运行期间，访问时link的version会与源dep同步
   * - 运行后，version为-1(从未使用过)的链接会被清理
   */
  version: number

  /**
   * 双向链表的指针
   */
  nextDep?: Link // 下一个依赖
  prevDep?: Link // 上一个依赖
  nextSub?: Link // 下一个订阅者
  prevSub?: Link // 上一个订阅者
  prevActiveLink?: Link // 上一个活动链接

  /**
   * 构造函数
   * @param sub - 订阅者(副作用)
   * @param dep - 依赖
   */
  constructor(
    public sub: Subscriber, // 订阅此依赖的副作用
    public dep: Dep, // 此链接关联的依赖
  ) {
    this.version = dep.version
    // 初始化所有指针为undefined
    this.nextDep =
      this.prevDep =
      this.nextSub =
      this.prevSub =
      this.prevActiveLink =
        undefined
  }
}

/**
 * 依赖类，管理响应式数据的订阅者(副作用)
 * @internal
 */
export class Dep {
  version = 0 // 依赖的版本号，每次更新时递增
  /**
   * 此依赖与当前活动副作用之间的链接
   */
  activeLink?: Link = undefined

  /**
   * 表示订阅此依赖的副作用的双向链表(尾部)
   */
  subs?: Link = undefined

  /**
   * 表示订阅此依赖的副作用的双向链表(头部)
   * 仅开发环境使用，用于按正确顺序调用onTrigger钩子
   */
  subsHead?: Link

  /**
   * 用于对象属性依赖的清理
   */
  map?: KeyToDepMap = undefined
  key?: unknown = undefined

  /**
   * 订阅者计数器
   */
  sc: number = 0

  /**
   * @internal
   * 标记此对象为依赖对象，避免被递归代理
   */
  readonly __v_skip = true
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  /**
   * 构造函数
   * @param computed - 可选的计算属性引用实现，用于计算属性的依赖
   */
  constructor(public computed?: ComputedRefImpl | undefined) {
    if (__DEV__) {
      this.subsHead = undefined
    }
  }

  /**
   * 追踪依赖
   * @param debugInfo - 调试信息，开发环境使用
   * @returns 创建或复用的链接对象
   */
  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    // 如果没有活动副作用、不应该追踪或者副作用是计算属性自己，则不追踪
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink
    // 如果没有活动链接或链接的订阅者不是当前活动副作用，创建新链接
    if (link === undefined || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this)

      // 将链接添加到活动副作用的依赖列表中(作为尾部)
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link
      } else {
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }

      // 添加订阅者
      addSub(link)
    } else if (link.version === -1) {
      // 从上次运行中重用 - 已经是订阅者，只同步版本号
      link.version = this.version

      // 如果此依赖有下一个依赖，说明它不在尾部 - 将它移到尾部
      // 这确保副作用的依赖列表按照它们在评估期间被访问的顺序排列
      if (link.nextDep) {
        const next = link.nextDep
        next.prevDep = link.prevDep
        if (link.prevDep) {
          link.prevDep.nextDep = next
        }

        link.prevDep = activeSub.depsTail
        link.nextDep = undefined
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link

        // 这是头部 - 指向新头部
        if (activeSub.deps === link) {
          activeSub.deps = next
        }
      }
    }

    // 开发环境下调用onTrack钩子
    if (__DEV__ && activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub,
          },
          debugInfo,
        ),
      )
    }

    return link
  }

  /**
   * 触发依赖更新
   * @param debugInfo - 调试信息，开发环境使用
   */
  trigger(debugInfo?: DebuggerEventExtraInfo): void {
    // 递增版本号
    this.version++
    globalVersion++
    // 通知所有订阅者
    this.notify(debugInfo)
  }

  /**
   * 通知所有订阅者更新
   * @param debugInfo - 调试信息，开发环境使用
   */
  notify(debugInfo?: DebuggerEventExtraInfo): void {
    // 开始批处理
    startBatch()
    try {
      if (__DEV__) {
        // 订阅者以相反顺序通知和批处理，然后在批处理结束时以原始顺序调用，
        // 但onTrigger钩子应该在此处以原始顺序调用
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & EffectFlags.NOTIFIED)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub,
                },
                debugInfo,
              ),
            )
          }
        }
      }
      // 反向遍历订阅者链表并通知每个订阅者
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          // 如果notify()返回`true`，这是一个计算属性，也在其依赖上调用notify
          // 这是在这里而不是在computed的notify内部调用，以减少调用堆栈深度
          ;(link.sub as ComputedRefImpl).dep.notify()
        }
      }
    } finally {
      // 结束批处理
      endBatch()
    }
  }
}

/**
 * 添加订阅者到依赖
 * @param link - 订阅链接
 */
function addSub(link: Link) {
  // 增加订阅计数器
  link.dep.sc++
  if (link.sub.flags & EffectFlags.TRACKING) {
    const computed = link.dep.computed
    // 计算属性获得第一个订阅者
    // 启用跟踪并惰性订阅其所有依赖
    if (computed && !link.dep.subs) {
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l)
      }
    }

    const currentTail = link.dep.subs
    if (currentTail !== link) {
      link.prevSub = currentTail
      if (currentTail) currentTail.nextSub = link
    }

    // 开发环境下设置链表头
    if (__DEV__ && link.dep.subsHead === undefined) {
      link.dep.subsHead = link
    }

    // 设置为新的尾部
    link.dep.subs = link
  }
}

// 存储{target -> key -> dep}连接的主WeakMap
// 概念上，更容易将依赖视为维护订阅者集合的Dep类，
// 但我们简单地将它们存储为原始Map以减少内存开销

type KeyToDepMap = Map<any, Dep>

/**
 * 全局目标对象到依赖映射的WeakMap
 */
export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

/**
 * 对象迭代符号，用于追踪对象的迭代操作
 */
export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)

/**
 * Map键迭代符号，用于追踪Map的键迭代操作
 */
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)

/**
 * 数组迭代符号，用于追踪数组的迭代操作
 */
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * 追踪对响应式属性的访问
 *
 * 这将检查当前正在运行的副作用并将其记录为依赖项，
 * 这些依赖项记录了所有依赖于响应式属性的副作用
 *
 * @param target - 持有响应式属性的对象
 * @param type - 定义对响应式属性的访问类型
 * @param key - 要跟踪的响应式属性的标识符
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  // 只有在应该追踪且存在活动副作用时才进行追踪
  if (shouldTrack && activeSub) {
    // 获取目标对象的依赖映射
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 获取属性的依赖对象
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep()))
      dep.map = depsMap
      dep.key = key
    }
    // 开发环境下传递调试信息
    if (__DEV__) {
      dep.track({
        target,
        type,
        key,
      })
    } else {
      dep.track()
    }
  }
}

/**
 * 查找与目标关联的所有依赖项(或特定属性)并触发其中存储的副作用
 *
 * @param target - 响应式对象
 * @param type - 定义需要触发副作用的操作类型
 * @param key - 可用于定位目标对象中的特定响应式属性
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
): void {
  // 获取目标对象的依赖映射
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // 从未被追踪过
    globalVersion++
    return
  }

  // 触发依赖的函数
  const run = (dep: Dep | undefined) => {
    if (dep) {
      // 开发环境下传递详细调试信息
      if (__DEV__) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      } else {
        dep.trigger()
      }
    }
  }

  // 开始批处理
  startBatch()

  // 根据不同操作类型处理
  if (type === TriggerOpTypes.CLEAR) {
    // 集合被清空
    // 触发目标的所有副作用
    depsMap.forEach(run)
  } else {
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    // 特殊处理数组length属性变化
    if (targetIsArray && key === 'length') {
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          key === 'length' ||
          key === ARRAY_ITERATE_KEY ||
          (!isSymbol(key) && key >= newLength)
        ) {
          run(dep)
        }
      })
    } else {
      // 处理SET | ADD | DELETE操作
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key))
      }

      // 对于任何数字键变化(长度上面已处理)，调度ARRAY_ITERATE
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // 对于ADD | DELETE | Map.SET操作，也为迭代键运行
      switch (type) {
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // 新索引添加到数组 -> 长度变化
            run(depsMap.get('length'))
          }
          break
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            run(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  // 结束批处理
  endBatch()
}

/**
 * 从响应式对象获取特定属性的依赖
 *
 * @param object - 响应式对象
 * @param key - 属性键
 * @returns 依赖对象或undefined
 */
export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): Dep | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
