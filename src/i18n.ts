import * as fs from 'fs'
import * as path from 'path'
import * as CSV from 'comma-separated-values'
import { app, remote } from 'electron'

/**
 * 本地化，单条语句翻译对象
 * @param params 格式化参数，会自动替换文本中的 $1、$2
 */
declare function Locale(
  /**
   * 若干个字符串，依次填充到 $1、$2
   */
  ...params: string[]
): string

interface Locale {
  /**
   * 格式化该键对应的翻译文本并返回
   */
  (
    /**
     * 若干个字符串，依次填充到 $1、$2
     */
    ...params: string[]
  ): string

  /**
   * 绑定该条翻译到指定DOM元素的 innerText
   * @param htmlElement 要绑定的 HTMLElement 元素
   * @param params 格式化参数，会自动替换文本中的 $1、$2
   */
  renderAsText(
    /**
     * 必须是标准的 HTMLElement DOM 元素
     */
    htmlElement: HTMLElement,
    /**
     * 若干个字符串，依次填充到 $1、$2
     */
    ...params: string[]
  ): void
  /**
   * 绑定该条翻译到指定DOM元素的 innerHTML
   * @param htmlElement 要绑定的 HTMLElement 元素
   * @param params 格式化参数，会自动替换文本中的 $1、$2
   */
  renderAsHTML(
    /**
     * 必须是标准的 HTMLElement DOM 元素
     */
    htmlElement: HTMLElement,
    /**
     * 若干个字符串，依次填充到 $1、$2
     */
    ...params: string[]
  ): void

  // [key: string]: string;
}

interface StringPack {
  [key: string]: string | StringPack
}

interface BindElement {
  locale: Locale
  htmlElement: HTMLElement
  type: 'text' | 'html'
  args: string[]
}

interface I18nInitConfig {
  /**
   * 翻译文件所在的文件夹路径
   */
  directory?: string
  /**
   * 语言偏好列表，越靠前越优先
   */
  actives?: string[]
  /**
   * 在找不到翻译文本时的默认语言
   */
  defaultLocale?: string
  /**
   * 是否监听文件修改，以自动更新翻译
   */
  autoReload?: boolean
}

/**
 * 自动地判断并读取一个js或者是json
 * @param filePath Path
 */
function readLangFile(filePath: string): StringPack {
  switch (path.extname(filePath)) {
    case '.js':
      delete require.cache[filePath]
      return require(filePath)
    case '.json':
      return JSON.parse(fs.readFileSync(filePath, { encoding: 'utf-8' }))
    case '.csv':
      const csv: string[][] = CSV.parse(fs.readFileSync(filePath).toString(), {
        cast: false
      })
      const localeObj: StringPack = {}
      csv.forEach((line: string[]) => {
        localeObj[line[0]] = line[2]
      })
      return localeObj
    default:
      return {}
  }
}

/**
 * 读取一个文件夹以及内部所有类JSON文件
 * @param dirPath Path
 * @returns
 * {
 *  'filename': {
 *     'key': 'value'
 *   }
 * }
 */
function readLangDir(dirPath: string): StringPack {
  const lang = {}
  const files = fs.readdirSync(dirPath)
  const filesPath = files.map(fileName => {
    return path.join(dirPath, fileName)
  })
  filesPath.forEach((filePath, index) => {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      lang[files[index]] = readLangDir(filePath)
    } else {
      const fileName = files[index]
      lang[path.basename(fileName, path.extname(fileName))] = readLangFile(
        filePath
      )
    }
  })
  return lang
}

export interface I18nConstructor {
  directory?: string
  actives?: string[]
  defaultLocale?: string
  autoReload?: boolean
}

class I18n {
  /**
   * 获取翻译文本
   */
  get text() {
    return this.pText
  }
  get t() {
    return this.text
  }
  get _() {
    return this.text
  }

  /**
   * 已经加载的翻译文本
   */
  get locals() {
    return this.pLocals
  }

  /**
   * 活动的语言列表的拷贝
   */
  get actives(): string[] {
    const copy = this.pActives.concat()
    copy.pop()
    return copy
  }

  set actives(localTags: string[]) {
    this.pActives = localTags.concat(this.defaultLocale)
    this._updateLocales()
  }

  defaultLocale: string
  private pActives
  private pLocals: StringPack
  private pBindElementList: BindElement[]
  private pText

  constructor(arg: I18nConstructor) {
    const {
      directory = path.join(__dirname, 'i18n'),
      actives = [],
      defaultLocale = 'en-US'
    } = arg
    // 如果文件夹参数不是文件夹，报错
    if (!fs.statSync(directory).isDirectory) {
      throw new Error('param directory is not a directory')
    }

    // 如果文件夹为空，报错
    if (!fs.readdirSync(directory)) {
      throw new Error('directory is empty, please make sure there is any files')
    }

    // 读取所有翻译文本
    this.pLocals = readLangDir(directory)
    // 设置一个绑定列表
    this.pBindElementList = []
    // 当优先语言全部不存在，则加载该默认语言
    this.defaultLocale = defaultLocale
    // 设置活动的语言列表
    this.actives = actives
    ;(() => {
      /**
       * 格式化模板字符串
       * @param str
       * @param args
       */
      const formatString = (str: string, ...args: string[]) => {
        for (const index in args) {
          if (args[index]) {
            str = str.replace(`$${index}`, args[index])
          }
        }
        return str
      }
      /**
       * 创建一个被包装过的Object
       * @param chainsArray 调用链
       */
      const createProxy = (chainsArray: string[]) => {
        return new Proxy(
          (() => {
            const f = (...args: string[]) => {
              // TODO: Replace it with for ... of
              for (let i = 0; i < this.pActives.length; i++) {
                let localeObj = this.locals[this.pActives[i]]
                if (!localeObj) {
                  continue
                }
                for (let j = 0; j < f._chains.length; j++) {
                  localeObj = localeObj[f._chains[j]]
                  if (!localeObj) {
                    break
                  } else if (j === f._chains.length - 1) {
                    return formatString(localeObj as string, ...args)
                  }
                }
              }
              return 'MissingText'
            }
            f._chains = chainsArray
            f.renderAsText = (htmlElement: HTMLElement, ...args: string[]) => {
              this.bindElementText(f, htmlElement, ...args)
            }
            f.renderAsHTML = (htmlElement: HTMLElement, ...args: string[]) => {
              this.bindElementHTML(f, htmlElement, ...args)
            }
            f.toString = () => f.call(this)
            return f
          })(),
          {
            get: (target, key) => {
              if (!target[key]) {
                target[key] = createProxy(target._chains.concat(key.toString()))
              }
              return target[key]
            }
          }
        )
      }
      this.pText = new Proxy(
        {},
        {
          get: (target, key) => {
            const arr: string[] = []
            return createProxy(arr.concat(key as string))
          }
        }
      )
    })()
  }

  /**
   * 解绑指定DOM元素的所有绑定
   * @param Element Element
   */
  unbindElement(htmlElement: Element) {
    // FIXME: 完成该函数
    // htmlElementTest 是假的
    // this._bindElementList = this._bindElementList.filter(
    //   ({ htmlElementTest }) => {
    //     return htmlElementTest !== htmlElement;
    //   }
    // );
  }

  /**
   * 绑定一条翻译到指定DOM元素的 innerText
   * @param locale 一个locale函数对象
   * @param htmlElement HTMLElement
   * @param args locale参数
   */
  bindElementText(locale: Locale, htmlElement: HTMLElement, ...args: string[]) {
    return this._bindElement(locale, htmlElement, 'text', ...args)
  }

  /**
   * 绑定一条翻译到指定DOM元素的 innerHTML
   * @param locale 一个locale函数对象
   * @param htmlElement HTMLElement
   * @param args locale参数
   */
  bindElementHTML(locale: Locale, htmlElement: HTMLElement, ...args: string[]) {
    return this._bindElement(locale, htmlElement, 'html', ...args)
  }

  /**
   * 根据 dataset.i18n 绑定翻译到DOM元素树 Text
   * @param htmlElement HTMLElement
   */
  parseAllElementsText(htmlElement: HTMLElement) {
    return this._parseAllElements(htmlElement, 'text')
  }

  /**
   * 根据 dataset.i18n 绑定翻译到DOM元素树 HTML
   * @param htmlElement HTMLElement
   */
  parseAllElementsHTML(htmlElement: HTMLElement) {
    return this._parseAllElements(htmlElement, 'html')
  }

  /**
   * 更新所有绑定翻译的内容
   */
  private _updateLocales() {
    this.pBindElementList.forEach(({ locale, htmlElement, type, args }) => {
      const text = locale(...args)
      if (type === 'text') {
        htmlElement.innerText = text
      } else {
        // 'html'
        htmlElement.innerHTML = text
      }
    })
  }

  /**
   * 绑定一条翻译到指定DOM元素
   * @param locale 一个locale函数对象
   * @param htmlElement HTMLElement
   * @param type 绑定到的类型
   * @param args locale参数
   */
  private _bindElement(
    locale: Locale,
    htmlElement: HTMLElement,
    type: 'text' | 'html',
    ...args: string[]
  ) {
    this.pBindElementList.push({
      locale,
      htmlElement,
      type,
      args
    })
    this._updateLocales()
  }

  /**
   * 根据 dataset.i18n 绑定翻译到DOM元素树
   * @param htmlElement HTMLElement
   * @param type 绑定到的类型
   * @param args locale参数
   */
  private _parseAllElements(
    htmlElement: HTMLElement,
    type: 'text' | 'html',
    ...args: string[]
  ) {
    /**
     * 渲染翻译
     * @param element
     */
    const renderElement = (element: HTMLElement) => {
      const i18nLocaleKeyChain = element.dataset.i18n.split('.')
      const i18nLocaleElement = (() => {
        let selectedElement = this.text
        i18nLocaleKeyChain.forEach(i18nLocaleKey => {
          selectedElement = selectedElement[i18nLocaleKey]
        })
        return selectedElement
      })()
      this._bindElement(i18nLocaleElement, element, type, ...args)
    }
    if (htmlElement.getAttribute('data-i18n')) {
      renderElement(htmlElement)
    }
    htmlElement.querySelectorAll('[data-i18n]').forEach(renderElement)
  }
}

export default new I18n({
  actives: [(app || remote.app).getLocale()]
})
