def is_leap(year):   
    if year % 4 != 0:   
        return False
    if year % 100 != 0:  
        return True
    return False


def days_in_year(year):  
    return 366 if is_leap(year) else 365  
