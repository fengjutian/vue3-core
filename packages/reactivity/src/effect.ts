// Vue 3响应式系统 - 副作用模块实现
// 此模块实现了Vue 3中的副作用系统，是响应式系统的核心部分，负责依赖收集和更新触发

import { extend, hasChanged } from '@vue/shared' // 共享工具函数
import type { ComputedRefImpl } from './computed' // 计算属性引用实现类型
import type { TrackOpTypes, TriggerOpTypes } from './constants' // 追踪和触发操作类型
import { type Link, globalVersion } from './dep' // 依赖链接类型和全局版本
import { activeEffectScope } from './effectScope' // 当前活动的副作用作用域
import { warn } from './warning' // 警告工具函数

/**
 * 副作用调度器类型
 */
export type EffectScheduler = (...args: any[]) => any

/**
 * 调试器事件类型
 */
export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

/**
 * 调试器事件额外信息类型
 */
export type DebuggerEventExtraInfo = {
  target: object // 目标对象
  type: TrackOpTypes | TriggerOpTypes // 操作类型（追踪或触发）
  key: any // 属性键
  newValue?: any // 新值
  oldValue?: any // 旧值
  oldTarget?: Map<any, any> | Set<any> // 旧目标（Map或Set类型）
}

/**
 * 调试器选项接口
 */
export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void // 追踪时的回调函数
  onTrigger?: (event: DebuggerEvent) => void // 触发时的回调函数
}

/**
 * 响应式副作用选项接口
 */
export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler // 调度器函数
  allowRecurse?: boolean // 是否允许递归
  onStop?: () => void // 停止时的回调函数
}

/**
 * 响应式副作用运行器接口
 */
export interface ReactiveEffectRunner<T = any> {
  (): T // 运行函数
  effect: ReactiveEffect // 对应的副作用对象
}

/**
 * 当前活动的订阅者（副作用）
 */
export let activeSub: Subscriber | undefined

/**
 * 副作用标志枚举
 * 用于标记副作用的各种状态
 */
export enum EffectFlags {
  /**
   * 活动状态（仅ReactiveEffect有）
   */
  ACTIVE = 1 << 0,
  RUNNING = 1 << 1, // 正在运行
  TRACKING = 1 << 2, // 正在追踪依赖
  NOTIFIED = 1 << 3, // 已通知更新
  DIRTY = 1 << 4, // 脏状态，需要重新计算
  ALLOW_RECURSE = 1 << 5, // 允许递归
  PAUSED = 1 << 6, // 已暂停
  EVALUATED = 1 << 7, // 已计算
}

/**
 * 订阅者接口，用于追踪（或订阅）依赖列表
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * 代表依赖的双向链表头部
   * @internal
   */
  deps?: Link
  /**
   * 同一链表的尾部
   * @internal
   */
  depsTail?: Link
  /**
   * 副作用标志
   * @internal
   */
  flags: EffectFlags
  /**
   * 下一个订阅者
   * @internal
   */
  next?: Subscriber
  /**
   * 通知更新
   * 返回`true`表示这是一个需要在其依赖上调用notify的计算属性
   * @internal
   */
  notify(): true | void
}

/**
 * 存储已暂停队列中的副作用
 */
const pausedQueueEffects = new WeakSet<ReactiveEffect>()

/**
 * 响应式副作用类
 * 实现响应式副作用的核心逻辑，包括依赖收集和触发更新
 */
export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * 依赖链表头部
   * @internal
   */
  deps?: Link = undefined
  /**
   * 依赖链表尾部
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * 副作用标志，初始为活动且可追踪状态
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * 下一个订阅者
   * @internal
   */
  next?: Subscriber = undefined
  /**
   * 清理函数
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined // 调度器函数
  onStop?: () => void // 停止时的回调
  onTrack?: (event: DebuggerEvent) => void // 追踪时的回调
  onTrigger?: (event: DebuggerEvent) => void // 触发时的回调

  /**
   * 构造函数
   * @param fn - 副作用函数
   */
  constructor(public fn: () => T) {
    // 如果存在活动的副作用作用域，将此副作用添加到作用域中
    if (activeEffectScope && activeEffectScope.active) {
      activeEffectScope.effects.push(this)
    }
  }

  /**
   * 暂停副作用
   */
  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  /**
   * 恢复副作用
   */
  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      // 如果在暂停期间有更新被队列化，现在触发它
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * 通知副作用更新
   * @internal
   */
  notify(): void {
    // 如果正在运行且不允许递归，直接返回
    if (
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    // 如果尚未通知，将其批量处理
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      batch(this)
    }
  }

  /**
   * 运行副作用函数
   * @returns 副作用函数的返回值
   */
  run(): T {
    // 如果副作用已停止，直接执行函数而不触发依赖追踪
    if (!(this.flags & EffectFlags.ACTIVE)) {
      return this.fn()
    }

    // 设置运行标志
    this.flags |= EffectFlags.RUNNING
    // 清理副作用的清理函数
    cleanupEffect(this)
    // 准备依赖追踪
    prepareDeps(this)
    // 保存之前的活动副作用和追踪状态
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    // 设置当前副作用为活动副作用
    activeSub = this
    shouldTrack = true

    try {
      // 执行副作用函数
      return this.fn()
    } finally {
      // 开发环境下检查副作用是否正确恢复
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      // 清理未使用的依赖
      cleanupDeps(this)
      // 恢复之前的活动副作用和追踪状态
      activeSub = prevEffect
      shouldTrack = prevShouldTrack
      // 清除运行标志
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  /**
   * 停止副作用
   * 取消所有依赖的订阅并执行停止回调
   */
  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      // 移除所有依赖的订阅
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      // 清空依赖链表
      this.deps = this.depsTail = undefined
      // 执行副作用的清理函数
      cleanupEffect(this)
      // 执行停止回调
      this.onStop && this.onStop()
      // 清除活动标志
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  /**
   * 触发副作用
   * 可以是立即运行或通过调度器延迟运行
   */
  trigger(): void {
    // 如果副作用已暂停，将其添加到暂停队列
    if (this.flags & EffectFlags.PAUSED) {
      pausedQueueEffects.add(this)
    }
    // 如果有调度器，使用调度器
    else if (this.scheduler) {
      this.scheduler()
    }
    // 否则直接检查是否需要运行
    else {
      this.runIfDirty()
    }
  }

  /**
   * 仅当副作用为脏状态时运行
   * @internal
   */
  runIfDirty(): void {
    if (isDirty(this)) {
      this.run()
    }
  }

  /**
   * 检查副作用是否为脏状态
   */
  get dirty(): boolean {
    return isDirty(this)
  }
}

// 以下是调试用函数，已注释
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

/**
 * 批处理深度计数器
 */
let batchDepth = 0
/**
 * 批处理中的订阅者链表头
 */
let batchedSub: Subscriber | undefined
/**
 * 批处理中的计算属性链表头
 */
let batchedComputed: Subscriber | undefined

/**
 * 批量处理副作用更新
 * @param sub - 要处理的订阅者
 * @param isComputed - 是否为计算属性
 */
export function batch(sub: Subscriber, isComputed = false): void {
  // 标记订阅者为已通知状态
  sub.flags |= EffectFlags.NOTIFIED
  if (isComputed) {
    // 将计算属性添加到计算属性批处理链表
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  // 将普通订阅者添加到批处理链表
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * 开始批处理
 * @internal
 */
export function startBatch(): void {
  batchDepth++
}

/**
 * 结束批处理并运行所有批处理的副作用
 * @internal
 */
export function endBatch(): void {
  // 如果批处理深度大于0，说明外部还有批处理，不执行
  if (--batchDepth > 0) {
    return
  }

  // 处理计算属性
  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      e = next
    }
  }

  // 处理普通副作用，捕获可能的错误
  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      // 仅处理活动状态的副作用
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE标志仅适用于effect
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          // 只捕获第一个错误，稍后抛出
          if (!error) error = err
        }
      }
      e = next
    }
  }

  // 如果有错误，抛出
  if (error) throw error
}

/**
 * 准备依赖追踪
 * @param sub - 订阅者
 */
function prepareDeps(sub: Subscriber) {
  // 从头部开始准备依赖追踪
  for (let link = sub.deps; link; link = link.nextDep) {
    // 将所有前一个依赖的版本设置为-1，以便在运行后跟踪哪些依赖未使用
    link.version = -1
    // 存储之前的活动链接（如果链接在另一个上下文中使用）
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

/**
 * 清理未使用的依赖
 * @param sub - 订阅者
 */
function cleanupDeps(sub: Subscriber) {
  // 从尾部开始清理未使用的依赖（逆序处理避免迭代问题）
  let head
  let tail = sub.depsTail
  let link = tail
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      // 版本为-1表示此依赖在本次运行中未被访问
      if (link === tail) tail = prev
      // 从依赖的订阅者列表中移除
      removeSub(link)
      // 从副作用的依赖列表中移除
      removeDep(link)
    } else {
      // 新的头部是最后一个未被移除的节点
      head = link
    }

    // 恢复之前的活动链接
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
    link = prev
  }
  // 设置新的头尾节点
  sub.deps = head
  sub.depsTail = tail
}

/**
 * 检查订阅者是否为脏状态（需要更新）
 * @param sub - 订阅者
 * @returns 是否为脏状态
 */
function isDirty(sub: Subscriber): boolean {
  // 检查每个依赖的版本是否已更新
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      link.dep.version !== link.version ||
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // 向后兼容：处理手动设置的脏标志（如Pinia测试模块使用）
  // @ts-expect-error 为了向后兼容
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * 刷新计算属性的值
 * 返回undefined表示刷新成功
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  // 如果计算属性正在追踪且不是脏状态，直接返回
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }
  // 清除脏标志
  computed.flags &= ~EffectFlags.DIRTY

  // 全局版本快速路径：如果自上次刷新以来没有响应式变化
  if (computed.globalVersion === globalVersion) {
    return
  }
  // 更新全局版本
  computed.globalVersion = globalVersion

  // 在SSR中没有渲染副作用，计算属性没有订阅者且不跟踪依赖，因此不能依赖脏检查
  // 计算属性总是重新计算，并依赖上面的全局版本快速路径进行缓存
  // #12337 如果计算属性没有依赖（不依赖任何响应式数据）且已计算，则不需要重新计算
  if (
    !computed.isSSR &&
    computed.flags & EffectFlags.EVALUATED &&
    ((!computed.deps && !(computed as any)._dirty) || !isDirty(computed))
  ) {
    return
  }
  // 设置运行标志
  computed.flags |= EffectFlags.RUNNING

  // 保存计算属性的依赖和当前活动的副作用
  const dep = computed.dep
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    // 准备依赖追踪
    prepareDeps(computed)
    // 执行计算函数
    const value = computed.fn(computed._value)
    // 如果是首次计算或值发生变化，更新值和版本
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= EffectFlags.EVALUATED
      computed._value = value
      dep.version++
    }
  } catch (err) {
    // 即使出错也要增加版本号，确保下次能够重新计算
    dep.version++
    throw err
  } finally {
    // 恢复之前的活动副作用和追踪状态
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    // 清理未使用的依赖
    cleanupDeps(computed)
    // 清除运行标志
    computed.flags &= ~EffectFlags.RUNNING
  }
}

/**
 * 从依赖的订阅者列表中移除订阅者
 * @param link - 订阅链接
 * @param soft - 是否为软移除（不移除订阅计数）
 */
function removeSub(link: Link, soft = false) {
  const { dep, prevSub, nextSub } = link
  // 从订阅者链表中移除
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  // 开发环境下检查链表头更新
  if (__DEV__ && dep.subsHead === link) {
    // 是前一个头节点，将新头指向next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // 是前一个尾节点，将新尾指向prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // 如果是计算属性且没有更多订阅者，取消它对所有依赖的订阅，以便GC
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // 这里只是"软"取消订阅，因为计算属性仍然引用依赖
        removeSub(l, true)
      }
    }
  }

  // 如果不是软移除且订阅计数减为0且有映射，删除依赖映射
  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // 属性依赖不再有副作用订阅者，删除它
    // 这主要是针对对象保留在内存中但只跟踪其部分属性的情况
    dep.map.delete(dep.key)
  }
}

/**
 * 从副作用的依赖列表中移除依赖
 * @param link - 依赖链接
 */
function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  // 从依赖链表中移除
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

/**
 * 创建一个副作用
 *
 * @example
 * ```js
 * const count = ref(0)
 * const effectFn = effect(() => {
 *   console.log(count.value)
 * })
 * // 运行副作用
 * effectFn()
 * // 停止副作用
 * stop(effectFn)
 * ```
 *
 * @param fn - 副作用函数
 * @param options - 副作用选项
 * @returns 副作用运行器，调用可执行副作用
 */
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  // 如果fn已经是一个副作用运行器，获取其原始函数
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建新的副作用实例
  const e = new ReactiveEffect(fn)
  // 应用选项
  if (options) {
    extend(e, options)
  }
  // 立即运行一次副作用
  try {
    e.run()
  } catch (err) {
    // 如果出错，停止副作用并重新抛出错误
    e.stop()
    throw err
  }
  // 创建运行器函数
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * 停止与给定运行器关联的副作用
 *
 * @param runner - 与要停止跟踪的副作用关联的运行器
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * 是否应该追踪依赖
 * @internal
 */
export let shouldTrack = true
/**
 * 追踪状态栈，用于暂停/恢复追踪
 */
const trackStack: boolean[] = []

/**
 * 临时暂停依赖追踪
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * 重新启用依赖追踪（如果已暂停）
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * 重置之前的全局依赖追踪状态
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 为当前活动的副作用注册清理函数
 * 清理函数会在下次副作用运行前或副作用停止时被调用
 *
 * 如果没有当前活动的副作用，会抛出警告。可以通过传递`true`给第二个参数来抑制警告
 *
 * @param fn - 要注册的清理函数
 * @param failSilently - 如果为`true`，在没有活动副作用时调用不会抛出警告
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

/**
 * 执行副作用的清理函数
 * @param e - 副作用
 */
function cleanupEffect(e: ReactiveEffect) {
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // 在没有活动副作用的情况下运行清理
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
