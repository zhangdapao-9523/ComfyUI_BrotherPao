import hashlib
import random
import requests

from comfy_api.latest import io

from ..config_manager import get_baidu_credentials

API_ENDPOINT = 'https://api.fanyi.baidu.com'
API_PATH = '/api/trans/vip/translate'
REQUEST_TIMEOUT = 15
MAX_TEXT_LENGTH = 6000


class BaiduTransDevApi(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_BaiduTrans",
            display_name="百度翻译(API)",
            category="❤️‍🩹炮哥Nodes/百度翻译",
            inputs=[
                io.String.Input(
                    "text",
                    multiline=True,
                    force_input=False,
                    default="",
                    placeholder="请输入要翻译的文本",
                ),
                io.Combo.Input("translate_to", options=["zh", "en"], default="zh"),
            ],
            outputs=[io.String.Output()],
        )

    @classmethod
    def execute(cls, text, translate_to='zh'):

        if not text or not text.strip():
            return io.NodeOutput("")

        text = text.strip()
        if len(text) > MAX_TEXT_LENGTH:
            return io.NodeOutput(f"文本过长，最大支持 {MAX_TEXT_LENGTH} 字符，当前 {len(text)} 字符")

        appid, appkey = get_baidu_credentials()
        if not appid or not appkey:
            return io.NodeOutput("[错误]配置文件不存在或缺少 appid/appkey，请在 config.json 中配置 baidu_translate.appid 和 baidu_translate.appkey")

        salt = random.randint(32768, 65536)
        sign_text = appid + text + str(salt) + appkey
        sign = hashlib.md5(sign_text.encode('utf-8')).hexdigest()

        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        payload = {
            'appid': appid,
            'q': text,
            'from': 'auto',
            'to': translate_to,
            'salt': salt,
            'sign': sign,
        }

        try:
            response = requests.post(
                API_ENDPOINT + API_PATH,
                params=payload,
                headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()

            if 'trans_result' in data:
                translated = '\n'.join(
                    item['dst'] for item in data['trans_result']
                )
                return io.NodeOutput(translated)

            error_code = data.get('error_code', '')
            return io.NodeOutput(f"百度翻译 API 错误 [错误码: {error_code}]")

        except requests.exceptions.Timeout:
            return io.NodeOutput("百度翻译请求超时，请稍后重试")
        except requests.exceptions.ConnectionError:
            return io.NodeOutput("[错误]无法连接到百度翻译服务器，请检查网络")
        except requests.exceptions.RequestException:
            return io.NodeOutput("网络请求异常，请稍后重试")
        except Exception:
            return io.NodeOutput("[错误]翻译过程发生异常，请稍后重试")
