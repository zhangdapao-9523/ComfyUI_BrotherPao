import json
import os
import hashlib
import random
import requests
import __main__

# 使用绝对路径来确保符号链接在不同驱动器上能正确处理
def get_absolute_path(relative_path):
    base_path = os.path.dirname(os.path.abspath(__main__.__file__))
    abs_path = os.path.abspath(os.path.join(base_path, relative_path))
    
    # 检查路径是否有效
    if not os.path.exists(abs_path):
        base_path = os.path.dirname(__file__)  # 切换到当前文件所在目录
        abs_path = os.path.abspath(os.path.join(base_path, relative_path))
    
    return abs_path

# 确保配置文件的正确路径
config_path = get_absolute_path('config.json')

# 检查配置文件是否存在
config_exists = os.path.exists(config_path)

# 从 JSON 文件中加载配置
if config_exists:
    try:
        with open(config_path, 'r') as config_file:
            config = json.load(config_file)
        # 从配置中提取 appid 和 appkey
        appid = config['baidu_translate']['appid']
        appkey = config['baidu_translate']['appkey']
    except (json.JSONDecodeError, KeyError):
        config_exists = False

class BaiduTrans_devapi:
    """百度翻译API节点，用于ComfyUI"""
    
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        """定义节点输入类型和UI显示设置"""
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

    def translation_devapi(self, 翻译为, text):
        """调用百度翻译API进行文本翻译"""
        # 检查配置文件是否存在
        if not config_exists:
            error_msg = "配置文件不存在，请创建config.json并配置appid和appkey"
            print(f"错误: {error_msg}")
            return (error_msg,)
            
        from_lang = 'auto'  # 源语言自动检测
        to_lang = 翻译为    # 目标语言，从UI参数获取
        endpoint = 'http://api.fanyi.baidu.com'
        path = '/api/trans/vip/translate'
        url = endpoint + path
        query = text
        
        # 如果没有输入文本，直接返回空结果
        if not query:
            return ("",)

        # 准备API请求参数
        salt = random.randint(32768, 65536)
        sign_text = appid + query + str(salt) + appkey
        sign = hashlib.md5(sign_text.encode('utf-8')).hexdigest()
        
        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        payload = {
            'appid': appid,
            'q': query,
            'from': from_lang,
            'to': to_lang,
            'salt': salt,
            'sign': sign
        }

        try:
            # 发送请求到百度翻译API
            response = requests.post(url, params=payload, headers=headers)
            response.raise_for_status()  # 检查HTTP状态码
            data = response.json()
            
            # 处理API响应
            if 'trans_result' in data:
                # 提取翻译结果并拼接
                translated_text = '\n'.join([item['dst'] for item in data['trans_result']])
                print(f'翻译结果: {translated_text}')
                return (translated_text,)
            else:
                # API返回错误信息
                error_msg = f"API错误: {data.get('error_msg', '未知错误')}"
                print(f"错误: {error_msg}")
                return (error_msg,)
                
        except requests.exceptions.RequestException as e:
            # 处理请求异常
            error_msg = f"网络请求异常: {str(e)}"
            print(f"错误: {error_msg}")
            return (error_msg,)
        except (KeyError, json.JSONDecodeError) as e:
            # 处理响应解析异常
            error_msg = f"响应解析错误: {str(e)}"
            print(f"错误: {error_msg}")
            return (error_msg,)

# 定义节点类映射，供ComfyUI识别
NODE_CLASS_MAPPINGS = {
    'BaiduTrans_DevApi': BaiduTrans_devapi,
}

# 定义节点显示名称映射
NODE_DISPLAY_NAME_MAPPINGS = {
    'BaiduTrans_DevApi': '百度翻译(API)',
}    
