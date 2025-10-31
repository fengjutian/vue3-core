// Vue 3响应式系统 - Ref模块实现
// 此模块实现了Vue 3中的引用类型响应式系统，包括ref、shallowRef、customRef等功能

import {
  type IfAny,
  hasChanged, // 判断两个值是否发生变化的工具函数
  isArray,
  isFunction,
  isObject,
} from '@vue/shared'
import { Dep, getDepFromReactive } from './dep' // 依赖收集和触发相关功能
import {
  type Builtin,
  type ShallowReactiveMarker,
  isProxy,
  isReactive,
  isReadonly,
  isShallow,
  toRaw, // 获取原始对象
  toReactive, // 将值转换为响应式
} from './reactive'
import type { ComputedRef, WritableComputedRef } from './computed'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants' // 常量定义
import { warn } from './warning'

// Ref接口标记符号，用于类型区分
declare const RefSymbol: unique symbol
export declare const RawSymbol: unique symbol

/**
 * Ref接口定义
 * 表示一个响应式引用，通过.value属性访问和修改其内部值
 * @template T - ref的值类型
 * @template S - 可接受的设置值类型
 */
export interface Ref<T = any, S = T> {
  get value(): T
  set value(_: S)
  /**
   * 仅用于类型区分
   * 在公共d.ts中需要但不希望在IDE自动完成中显示，因此使用私有Symbol
   */
  [RefSymbol]: true
}

/**
 * 检查一个值是否是ref对象
 *
 * @param r - 要检查的值
 * @returns 判断结果
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isref}
 */
export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
export function isRef(r: any): r is Ref {
  // 通过检查ReactiveFlags.IS_REF标记来判断是否为ref
  return r ? r[ReactiveFlags.IS_REF] === true : false
}

/**
 * 创建一个响应式的引用对象
 * 将内部值包装为响应式对象，通过.value属性访问
 *
 * @param value - 要包装的对象
 * @returns 响应式引用对象
 * @see {@link https://vuejs.org/api/reactivity-core.html#ref}
 */
export function ref<T>(
  value: T,
): [T] extends [Ref] ? IfAny<T, Ref<T>, T> : Ref<UnwrapRef<T>, UnwrapRef<T> | T>
export function ref<T = any>(): Ref<T | undefined>
export function ref(value?: unknown) {
  return createRef(value, false)
}

// 浅层引用标记
declare const ShallowRefMarker: unique symbol

/**
 * 浅层引用类型定义
 * 与普通ref不同，浅层引用不会递归转换内部值为响应式
 */
export type ShallowRef<T = any, S = T> = Ref<T, S> & {
  [ShallowRefMarker]?: true
}

/**
 * 创建一个浅层的响应式引用对象
 * 仅对.value的变更进行响应式处理，不会递归转换内部嵌套对象
 *
 * @example
 * ```js
 * const state = shallowRef({ count: 1 })
 * // 不会触发变更
 * state.value.count = 2
 * // 会触发变更
 * state.value = { count: 2 }
 * ```
 *
 * @param value - 浅层引用的内部值
 * @returns 浅层响应式引用对象
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowref}
 */
export function shallowRef<T>(
  value: T,
): Ref extends T
  ? T extends Ref
    ? IfAny<T, ShallowRef<T>, T>
    : ShallowRef<T>
  : ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

/**
 * 创建引用对象的内部函数
 * 共享ref和shallowRef的创建逻辑
 *
 * @param rawValue - 原始值
 * @param shallow - 是否为浅层引用
 * @returns 引用对象
 */
function createRef(rawValue: unknown, shallow: boolean) {
  // 如果已经是ref，直接返回
  if (isRef(rawValue)) {
    return rawValue
  }
  // 创建RefImpl实例
  return new RefImpl(rawValue, shallow)
}

/**
 * 引用实现类
 * 内部类，实现了Ref接口的具体逻辑
 *
 * @internal
 */
class RefImpl<T = any> {
  _value: T // 响应式包装后的值
  private _rawValue: T // 原始未包装的值

  dep: Dep = new Dep() // 依赖收集器

  // 标记为ref
  public readonly [ReactiveFlags.IS_REF] = true
  // 是否为浅层ref（默认为false）
  public readonly [ReactiveFlags.IS_SHALLOW]: boolean = false

  /**
   * 构造函数
   * @param value - 初始值
   * @param isShallow - 是否为浅层ref
   */
  constructor(value: T, isShallow: boolean) {
    // 存储原始值（非浅层模式下获取原始对象）
    this._rawValue = isShallow ? value : toRaw(value)
    // 存储响应式值（非浅层模式下转换为响应式）
    this._value = isShallow ? value : toReactive(value)
    // 设置浅层标记
    this[ReactiveFlags.IS_SHALLOW] = isShallow
  }

  /**
   * value的getter
   * 触发依赖收集
   */
  get value() {
    // 开发环境下记录详细依赖信息
    if (__DEV__) {
      this.dep.track({
        target: this,
        type: TrackOpTypes.GET,
        key: 'value',
      })
    } else {
      // 生产环境简化调用
      this.dep.track()
    }
    // 返回响应式包装后的值
    return this._value
  }

  /**
   * value的setter
   * 检查值是否变化，如果变化则触发更新
   */
  set value(newValue) {
    const oldValue = this._rawValue
    // 判断是否使用直接值（浅层ref、已经是响应式/只读/浅层的值不需要再次转换）
    const useDirectValue =
      this[ReactiveFlags.IS_SHALLOW] ||
      isShallow(newValue) ||
      isReadonly(newValue)
    // 获取原始值（如果不是直接使用的值）
    newValue = useDirectValue ? newValue : toRaw(newValue)

    // 值发生变化时才更新并触发依赖
    if (hasChanged(newValue, oldValue)) {
      // 更新原始值
      this._rawValue = newValue
      // 更新响应式值（非直接使用的情况需要转为响应式）
      this._value = useDirectValue ? newValue : toReactive(newValue)

      // 触发依赖更新
      if (__DEV__) {
        this.dep.trigger({
          target: this,
          type: TriggerOpTypes.SET,
          key: 'value',
          newValue,
          oldValue,
        })
      } else {
        this.dep.trigger()
      }
    }
  }
}

/**
 * 强制触发依赖于浅层ref的副作用函数
 * 通常用于对浅层ref的内部值进行深度修改后使用
 *
 * @example
 * ```js
 * const shallow = shallowRef({
 *   greet: 'Hello, world'
 * })
 *
 * // 首次运行时记录 "Hello, world"
 * watchEffect(() => {
 *   console.log(shallow.value.greet)
 * })
 *
 * // 这不触发副作用，因为ref是浅层的
 * shallow.value.greet = 'Hello, universe'
 *
 * // 记录 "Hello, universe"
 * triggerRef(shallow)
 * ```
 *
 * @param ref - 要触发其绑定副作用的ref
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#triggerref}
 */
export function triggerRef(ref: Ref): void {
  // ref可能是ObjectRefImpl的实例
  if ((ref as unknown as RefImpl).dep) {
    if (__DEV__) {
      ;(ref as unknown as RefImpl).dep.trigger({
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: (ref as unknown as RefImpl)._value,
      })
    } else {
      ;(ref as unknown as RefImpl).dep.trigger()
    }
  }
}

/**
 * 可能是ref或普通值的类型
 */
export type MaybeRef<T = any> =
  | T
  | Ref<T>
  | ShallowRef<T>
  | WritableComputedRef<T>

/**
 * 可能是ref、计算属性ref或值的getter函数的类型
 */
export type MaybeRefOrGetter<T = any> = MaybeRef<T> | ComputedRef<T> | (() => T)

/**
 * 解包ref，获取其内部值
 * 如果参数是ref，返回其.value，否则直接返回参数本身
 *
 * @example
 * ```js
 * function useFoo(x: number | Ref<number>) {
 *   const unwrapped = unref(x)
 *   // unwrapped保证现在是number类型
 * }
 * ```
 *
 * @param ref - 要解包的ref或普通值
 * @returns 解包后的值
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#unref}
 */
export function unref<T>(ref: MaybeRef<T> | ComputedRef<T>): T {
  return isRef(ref) ? ref.value : ref
}

/**
 * 将值/refs/getters规范化为值
 * 类似于unref，但也会规范化getter函数
 * 如果参数是getter，会调用它并返回其返回值
 *
 * @example
 * ```js
 * toValue(1) // 1
 * toValue(ref(1)) // 1
 * toValue(() => 1) // 1
 * ```
 *
 * @param source - getter函数、现有ref或非函数值
 * @returns 规范化后的值
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#tovalue}
 */
export function toValue<T>(source: MaybeRefOrGetter<T>): T {
  return isFunction(source) ? source() : unref(source)
}

/**
 * 浅层解包ref的代理处理器
 * 用于proxyRefs函数，为对象的ref属性提供自动解包功能
 */
const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) =>
    // 特殊处理RAW标记
    key === ReactiveFlags.RAW
      ? target
      : // 访问属性时自动解包ref
        unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    // 如果旧值是ref但新值不是，则更新ref的值而不是替换ref本身
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      // 其他情况正常设置
      return Reflect.set(target, key, value, receiver)
    }
  },
}

/**
 * 返回一个代理，自动解包对象中是ref的属性
 * 如果对象已经是响应式的，则直接返回
 *
 * @param objectWithRefs - 包含ref的对象或已响应式对象
 * @returns 具有自动解包功能的代理
 */
export function proxyRefs<T extends object>(
  objectWithRefs: T,
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? (objectWithRefs as ShallowUnwrapRef<T>)
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

/**
 * 自定义ref工厂函数类型
 * 用于创建具有显式依赖跟踪和更新触发控制的自定义ref
 */
export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void,
) => {
  get: () => T
  set: (value: T) => void
}

/**
 * 自定义ref实现类
 * 用于实现customRef函数的内部实现
 */
class CustomRefImpl<T> {
  public dep: Dep // 依赖收集器

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  // 标记为ref
  public readonly [ReactiveFlags.IS_REF] = true

  public _value: T = undefined! // 缓存的当前值

  /**
   * 构造函数
   * @param factory - 工厂函数，提供track和trigger回调
   */
  constructor(factory: CustomRefFactory<T>) {
    const dep = (this.dep = new Dep())
    // 获取工厂函数提供的get和set方法
    const { get, set } = factory(dep.track.bind(dep), dep.trigger.bind(dep))
    this._get = get
    this._set = set
  }

  /**
   * value的getter
   * 调用用户提供的get方法
   */
  get value() {
    return (this._value = this._get())
  }

  /**
   * value的setter
   * 调用用户提供的set方法
   */
  set value(newVal) {
    this._set(newVal)
  }
}

/**
 * 创建一个自定义ref，允许显式控制其依赖跟踪和更新触发
 *
 * @param factory - 接收track和trigger回调的工厂函数
 * @returns 自定义ref
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#customref}
 */
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

/**
 * 将响应式对象转换为ref对象集合的类型
 * 每个属性都是对应原始属性的ref
 */
export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}

/**
 * 将响应式对象转换为普通对象，其中每个属性都是指向原始对象对应属性的ref
 * 每个ref通过toRef创建
 *
 * @param object - 要转换为ref对象集合的响应式对象
 * @returns 包含原始对象所有属性对应ref的普通对象
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#torefs}
 */
export function toRefs<T extends object>(object: T): ToRefs<T> {
  if (__DEV__ && !isProxy(object)) {
    warn(`toRefs() 期望接收一个响应式对象，但接收到了一个普通对象。`)
  }
  // 根据原始对象是数组还是普通对象创建不同类型的返回值
  const ret: any = isArray(object) ? new Array(object.length) : {}
  // 遍历对象的每个属性，创建对应的ref
  for (const key in object) {
    ret[key] = propertyToRef(object, key)
  }
  return ret
}

/**
 * 对象属性ref实现类
 * 用于toRef函数，创建指向对象特定属性的ref
 */
class ObjectRefImpl<T extends object, K extends keyof T> {
  // 标记为ref
  public readonly [ReactiveFlags.IS_REF] = true
  public _value: T[K] = undefined! // 缓存的属性值

  /**
   * 构造函数
   * @param _object - 源对象
   * @param _key - 属性键名
   * @param _defaultValue - 可选的默认值
   */
  constructor(
    private readonly _object: T,
    private readonly _key: K,
    private readonly _defaultValue?: T[K],
  ) {}

  /**
   * value的getter
   * 读取源对象的属性值
   */
  get value() {
    const val = this._object[this._key]
    // 如果值未定义，返回默认值
    return (this._value = val === undefined ? this._defaultValue! : val)
  }

  /**
   * value的setter
   * 更新源对象的属性值
   */
  set value(newVal) {
    this._object[this._key] = newVal
  }

  /**
   * 获取源对象属性的依赖收集器
   * 用于triggerRef等函数
   */
  get dep(): Dep | undefined {
    return getDepFromReactive(toRaw(this._object), this._key)
  }
}

/**
 * Getter ref实现类
 * 用于创建基于getter函数的只读ref
 */
class GetterRefImpl<T> {
  // 标记为ref
  public readonly [ReactiveFlags.IS_REF] = true
  // 标记为只读
  public readonly [ReactiveFlags.IS_READONLY] = true
  public _value: T = undefined! // 缓存的getter返回值

  /**
   * 构造函数
   * @param _getter - 提供值的getter函数
   */
  constructor(private readonly _getter: () => T) {}

  /**
   * value的getter
   * 调用提供的getter函数
   */
  get value() {
    return (this._value = this._getter())
  }
}

/**
 * toRef函数返回类型
 * 保持ref类型不变，将非ref转换为ref
 */
export type ToRef<T> = IfAny<T, Ref<T>, [T] extends [Ref] ? T : Ref<T>>

/**
 * 将值/refs/getters规范化为refs
 *
 * @example
 * ```js
 * // 原样返回已有的ref
 * toRef(existingRef)
 *
 * // 创建一个在.value访问时调用getter的ref
 * toRef(() => props.foo)
 *
 * // 从非函数值创建普通ref
 * // 等效于ref(1)
 * toRef(1)
 * ```
 *
 * 也可用于为响应式对象的属性创建ref
 * 创建的ref与其源属性同步：修改源属性会更新ref，反之亦然
 *
 * @example
 * ```js
 * const state = reactive({
 *   foo: 1,
 *   bar: 2
 * })
 *
 * const fooRef = toRef(state, 'foo')
 *
 * // 修改ref会更新原始值
 * fooRef.value++
 * console.log(state.foo) // 2
 *
 * // 修改原始值也会更新ref
 * state.foo++
 * console.log(fooRef.value) // 3
 * ```
 *
 * @param source - getter函数、现有ref、非函数值或用于创建属性ref的响应式对象
 * @param [key] - (可选) 响应式对象中的属性名
 * @returns 对应的ref对象
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#toref}
 */
export function toRef<T>(
  value: T,
): T extends () => infer R
  ? Readonly<Ref<R>>
  : T extends Ref
    ? T
    : Ref<UnwrapRef<T>>
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
): ToRef<T[K]>
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue: T[K],
): ToRef<Exclude<T[K], undefined>>
export function toRef(
  source: Record<string, any> | MaybeRef,
  key?: string,
  defaultValue?: unknown,
): Ref {
  // 处理不同类型的输入
  if (isRef(source)) {
    return source
  } else if (isFunction(source)) {
    // 为getter函数创建只读ref
    return new GetterRefImpl(source) as any
  } else if (isObject(source) && arguments.length > 1) {
    // 为对象属性创建ref
    return propertyToRef(source, key!, defaultValue)
  } else {
    // 为普通值创建ref
    return ref(source)
  }
}

/**
 * 为对象属性创建ref的内部函数
 *
 * @param source - 源对象
 * @param key - 属性键名
 * @param defaultValue - 可选的默认值
 * @returns 指向对象属性的ref
 */
function propertyToRef(
  source: Record<string, any>,
  key: string,
  defaultValue?: unknown,
) {
  const val = source[key]
  // 如果属性值已经是ref，直接返回
  return isRef(val)
    ? val
    : (new ObjectRefImpl(source, key, defaultValue) as any)
}

/**
 * 特殊导出接口，供其他包声明应该在ref解包时跳过的额外类型
 * 例如，@vue/runtime-dom可以在其d.ts中这样声明：
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 */
export interface RefUnwrapBailTypes {}

/**
 * 浅层解包ref的类型
 * 仅解包对象属性中的ref，不递归解包
 */
export type ShallowUnwrapRef<T> = {
  [K in keyof T]: DistributeRef<T[K]>
}

/**
 * 分发ref类型的工具类型
 * 将ref类型解包为其值类型，其他类型保持不变
 */
type DistributeRef<T> = T extends Ref<infer V, unknown> ? V : T

/**
 * 递归解包ref的类型
 * 深度解包嵌套的ref类型
 */
export type UnwrapRef<T> =
  T extends ShallowRef<infer V, unknown>
    ? V
    : T extends Ref<infer V, unknown>
      ? UnwrapRefSimple<V>
      : UnwrapRefSimple<T>

/**
 * 简化的ref解包类型
 * 处理基本类型、内置类型和复杂类型的解包规则
 */
export type UnwrapRefSimple<T> = T extends
  | Builtin // 基本类型
  | Ref // ref类型
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes] // 声明的跳过类型
  | { [RawSymbol]?: true } // 原始标记对象
  ? T
  : T extends Map<infer K, infer V> // Map类型
    ? Map<K, UnwrapRefSimple<V>> & UnwrapRef<Omit<T, keyof Map<any, any>>>
    : T extends WeakMap<infer K, infer V> // WeakMap类型
      ? WeakMap<K, UnwrapRefSimple<V>> &
          UnwrapRef<Omit<T, keyof WeakMap<any, any>>>
      : T extends Set<infer V> // Set类型
        ? Set<UnwrapRefSimple<V>> & UnwrapRef<Omit<T, keyof Set<any>>>
        : T extends WeakSet<infer V> // WeakSet类型
          ? WeakSet<UnwrapRefSimple<V>> & UnwrapRef<Omit<T, keyof WeakSet<any>>>
          : T extends ReadonlyArray<any> // 数组类型
            ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
            : T extends object & { [ShallowReactiveMarker]?: never } // 对象类型
              ? {
                  [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
                }
              : T
