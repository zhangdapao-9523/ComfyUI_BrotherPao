import hashlib
import random
import requests

from ..config_manager import get_baidu_credentials

API_ENDPOINT = 'http://api.fanyi.baidu.com'
API_PATH = '/api/trans/vip/translate'
REQUEST_TIMEOUT = 15
MAX_TEXT_LENGTH = 6000


class BaiduTransDevApi:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            'required': {
                'text': ('STRING', {
                    'multiline': True,
                    'forceInput': False,
                    'default': '',
                    'placeholder': '请输入要翻译的文本'
                }),
                '翻译为': (['zh', 'en'], {'default': 'zh'}),
            },
        }

    RETURN_TYPES = ('STRING',)
    FUNCTION = 'translation_devapi'
    CATEGORY = '❤️‍🩹炮哥Nodes/百度翻译'

    def translation_devapi(self, text, 翻译为='zh'):

        if not text or not text.strip():
            return ("",)

        text = text.strip()
        if len(text) > MAX_TEXT_LENGTH:
            return (f"文本过长，最大支持 {MAX_TEXT_LENGTH} 字符，当前 {len(text)} 字符",)

        appid, appkey = get_baidu_credentials()
        if not appid or not appkey:
            return ("配置文件不存在或缺少 appid/appkey，请在 config.json 中配置 baidu_translate.appid 和 baidu_translate.appkey",)

        salt = random.randint(32768, 65536)
        sign_text = appid + text + str(salt) + appkey
        sign = hashlib.md5(sign_text.encode('utf-8')).hexdigest()

        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        payload = {
            'appid': appid,
            'q': text,
            'from': 'auto',
            'to': 翻译为,
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
                return (translated,)

            error_code = data.get('error_code', '')
            error_msg = data.get('error_msg', '未知错误')
            return (f"百度翻译 API 错误 [{error_code}]: {error_msg}",)

        except requests.exceptions.Timeout:
            return ("百度翻译请求超时，请稍后重试",)
        except requests.exceptions.ConnectionError:
            return ("无法连接到百度翻译服务器，请检查网络",)
        except requests.exceptions.RequestException as e:
            return (f"网络请求异常: {e}",)
        except Exception as e:
            return (f"翻译过程发生异常: {e}",)


NODE_CLASS_MAPPINGS = {
    'BrotherPao_BaiduTrans': BaiduTransDevApi,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    'BrotherPao_BaiduTrans': '百度翻译(API)',
}
