TEXT_TYPE = "STRING"

class DictionaryUpdate:
    """合并字典节点"""
    
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "字典1": ("DICT", {"lazy": True}),
                "字典2": ("DICT", {"lazy": True}),
            },
            "optional": {
                "字典3": ("DICT", {"lazy": True}),
                "字典4": ("DICT", {"lazy": True}),
                "字典5": ("DICT", {"lazy": True}),
                "字典6": ("DICT", {"lazy": True}),
                "字典7": ("DICT", {"lazy": True}),
                "字典8": ("DICT", {"lazy": True}),
                "字典9": ("DICT", {"lazy": True}),
                "字典10": ("DICT", {"lazy": True}),
            }
        }
    
    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("合并后的字典",)
    FUNCTION = "dictionary_update"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def check_lazy_status(self, **kwargs):
        needed = []
        for i in range(1, 11):
            key = f"字典{i}"
            if key in kwargs and kwargs[key] is None:
                needed.append(key)
        return needed

    def dictionary_update(self, **kwargs):
        合并字典 = {}
        for i in range(1, 11):
            key = f"字典{i}"
            if key in kwargs and kwargs[key] is not None:
                合并字典.update(kwargs[key])
        return (合并字典, )


class DictionaryGet:
    """获取字典值节点"""
    
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "字典": ("DICT", ),
                "键": ("STRING", {"default":"", "multiline": False}),
            },
            "optional": {
                "默认值": ("STRING", {"default":"", "multiline": False}),
            }
        }
    
    RETURN_TYPES = (TEXT_TYPE,)
    RETURN_NAMES = ("值",)
    FUNCTION = "dictionary_get"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def dictionary_get(self, 字典, 键, 默认值=""):
        return (str(字典.get(键, 默认值)), )


class DictionaryNew:
    """创建新字典节点"""
    
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "键1": ("STRING", {"default":"", "multiline": False}),
                "值1": ("STRING", {"default":"", "multiline": False}),
            },
            "optional": {
                "键2": ("STRING", {"default":"", "multiline": False}),
                "值2": ("STRING", {"default":"", "multiline": False}),
                "键3": ("STRING", {"default":"", "multiline": False}),
                "值3": ("STRING", {"default":"", "multiline": False}),
                "键4": ("STRING", {"default":"", "multiline": False}),
                "值4": ("STRING", {"default":"", "multiline": False}),
                "键5": ("STRING", {"default":"", "multiline": False}),
                "值5": ("STRING", {"default":"", "multiline": False}),
            }
        }
    
    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("字典",)
    FUNCTION = "dictionary_new"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def append_to_dictionary(self, 字典, 键, 值):
        if 键 is not None and 键 != "":
            字典[键] = 值
        return 字典

    def dictionary_new(self, 键1, 值1, 键2, 值2, 键3, 值3, 键4, 值4, 键5, 值5):
        字典 = {}
        字典 = self.append_to_dictionary(字典, 键1, 值1)
        字典 = self.append_to_dictionary(字典, 键2, 值2)
        字典 = self.append_to_dictionary(字典, 键3, 值3)
        字典 = self.append_to_dictionary(字典, 键4, 值4)
        字典 = self.append_to_dictionary(字典, 键5, 值5)
        return (字典, )


NODE_CLASS_MAPPINGS = {
    'DictionaryUpdate': DictionaryUpdate,
    'DictionaryGet': DictionaryGet,
    'DictionaryNew': DictionaryNew,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    'DictionaryUpdate': '字典合并',
    'DictionaryGet': '字典取值',
    'DictionaryNew': '新建字典',
}